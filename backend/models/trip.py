from typing import Optional

from pydantic import BaseModel


class TripIn(BaseModel):
    name: str
    travel_date: str  # DD-MM-YY
    budget: Optional[float] = None
    currency: str = "INR"


class TripUpdate(BaseModel):
    name: Optional[str] = None
    travel_date: Optional[str] = None
    budget: Optional[float] = None
    currency: Optional[str] = None


class AdminGrant(BaseModel):
    user_id: str
