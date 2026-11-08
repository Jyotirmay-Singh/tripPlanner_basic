"""Choose the Excel presentation from reconciled, saved expense evidence."""

from decimal import Decimal, InvalidOperation
from enum import Enum

from services.report_model import ReportData


class ExcelReportType(Enum):
    SINGLE_CURRENCY = "single_currency"
    MULTI_CURRENCY = "multi_currency"

    @property
    def includes_exchange_details(self) -> bool:
        return self is ExcelReportType.MULTI_CURRENCY


def select_excel_report_type(data: ReportData) -> ExcelReportType:
    """Use the compact layout only when every included expense is an identity conversion.

    Compare each original currency with the group currency, rather than counting source
    currencies: an INR group containing only USD expenses still needs exchange evidence.
    Unknown or inconsistent historical evidence retains the detailed layout. This decision
    uses the same included allocations as Transactions and the pivot; it performs no I/O and
    does not change money, source records, or saved exchange rates.
    """
    group_currency = data.currency.strip().upper()
    for allocation in data.allocations:
        if allocation.original_currency.strip().upper() != group_currency:
            return ExcelReportType.MULTI_CURRENCY
        try:
            rate = Decimal(allocation.exchange_rate)
        except (InvalidOperation, ValueError, TypeError):
            return ExcelReportType.MULTI_CURRENCY
        if not rate.is_finite() or rate != 1:
            return ExcelReportType.MULTI_CURRENCY
        if allocation.rate_provider != "identity" or allocation.rate_mode != "automatic":
            return ExcelReportType.MULTI_CURRENCY
    return ExcelReportType.SINGLE_CURRENCY
