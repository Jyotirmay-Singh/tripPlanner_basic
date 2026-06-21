from typing import Optional

from pydantic import BaseModel


class TripIn(BaseModel):
    name: str
    start_date: str  # YYYY-MM-DD (timezone-free calendar date)
    end_date: str    # YYYY-MM-DD, must be >= start_date
    budget: Optional[float] = None
    currency: str = "INR"


class TripUpdate(BaseModel):
    name: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    budget: Optional[float] = None
    currency: Optional[str] = None


class AdminGrant(BaseModel):
    user_id: str


class OwnershipTransfer(BaseModel):
    user_id: str
