"""Shared MongoDB transaction boundary for balance-changing ledger writes."""

from typing import Awaitable, Callable, TypeVar

from pymongo.errors import ConfigurationError, InvalidOperation, OperationFailure, PyMongoError

from database import client


T = TypeVar("T")
TransactionCallback = Callable[[object], Awaitable[T]]
FallbackCallback = Callable[[], Awaitable[T]]


class TransactionUnavailableError(RuntimeError):
    """The connected MongoDB deployment cannot provide transaction guarantees."""


def _transaction_unavailable(exc: BaseException) -> bool:
    if isinstance(exc, (ConfigurationError, InvalidOperation)):
        return True
    if isinstance(exc, OperationFailure) and exc.code in {20, 263, 303}:
        return True
    message = str(exc).lower()
    return any(fragment in message for fragment in (
        "transaction numbers are only allowed",
        "does not support sessions",
        "transactions are not supported",
        "replica set member or mongos",
    ))


def _known_transaction_capable() -> bool:
    """Use transactions only when Motor already knows it is connected to a capable topology."""

    try:
        topology = client.topology_description.topology_type_name
    except Exception:
        return False
    return topology in {"ReplicaSetWithPrimary", "ReplicaSetNoPrimary", "Sharded", "LoadBalanced"}


async def run_required_transaction(callback: TransactionCallback[T]) -> T:
    """Run a callback atomically or fail closed when transactions are unavailable."""

    try:
        async with await client.start_session() as session:
            return await session.with_transaction(callback)
    except Exception as exc:
        if _transaction_unavailable(exc):
            raise TransactionUnavailableError(
                "MongoDB transactions are unavailable"
            ) from exc
        raise


async def run_optional_transaction(
    callback: TransactionCallback[T],
    fallback: FallbackCallback[T],
) -> T:
    """Use a transaction on capable deployments and preserve the standalone legacy path."""

    if not _known_transaction_capable():
        return await fallback()
    try:
        return await run_required_transaction(callback)
    except TransactionUnavailableError:
        return await fallback()


def is_retryable_transaction_error(exc: BaseException) -> bool:
    if isinstance(exc, OperationFailure):
        try:
            return bool(
                exc.has_error_label("TransientTransactionError")
                or exc.has_error_label("UnknownTransactionCommitResult")
            )
        except Exception:
            return exc.code in {112, 244, 251}
    return isinstance(exc, PyMongoError) and "write conflict" in str(exc).lower()
