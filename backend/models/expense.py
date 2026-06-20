from typing import List, Optional, Literal

from pydantic import BaseModel

SplitMode = Literal["PER_CAPITA", "PER_FAMILY"]


class ExpenseIn(BaseModel):
    kind: Literal["expense", "income"] = "expense"
    amount: float
    category: str
    description: Optional[str] = ""
    date: str  # DD-MM-YY
    paid_by_member_id: str  # member id (individual or family) who paid
    split_member_ids: List[str] = []  # if empty, split among all
    split_mode: SplitMode = "PER_CAPITA"
    weight_snapshots: Optional[dict] = None  # member_id -> custom weight (e.g. partial family)
    receipt_id: Optional[str] = None  # GridFS receipt id (Step 22); set via the upload endpoint
    receipt_base64: Optional[str] = None  # legacy/read-only inline receipt (superseded by receipt_id)


class ExpenseUpdate(BaseModel):
    kind: Optional[Literal["expense", "income"]] = None
    amount: Optional[float] = None
    category: Optional[str] = None
    description: Optional[str] = None
    date: Optional[str] = None
    paid_by_member_id: Optional[str] = None
    split_member_ids: Optional[List[str]] = None
    split_mode: Optional[SplitMode] = None
    weight_snapshots: Optional[dict] = None
    receipt_id: Optional[str] = None  # GridFS receipt id (Step 22); set via the upload endpoint
    receipt_base64: Optional[str] = None  # legacy/read-only inline receipt (superseded by receipt_id)
    force: Optional[bool] = False
