from pydantic import BaseModel


class SettleIn(BaseModel):
    from_member_id: str
    to_member_id: str
    amount: float
