from typing import List, Optional, Literal

from pydantic import BaseModel, EmailStr


class MemberIn(BaseModel):
    name: str
    kind: Literal["individual", "family"] = "individual"
    family_members: List[str] = []  # names of family members
    email: Optional[EmailStr] = None  # optional email to auto-link an app user


class MemberUpdate(BaseModel):
    name: Optional[str] = None
    kind: Optional[Literal["individual", "family"]] = None
    family_members: Optional[List[str]] = None
    email: Optional[str] = None  # can be empty string to clear
    reweight_past: Optional[bool] = True  # if False, snapshot old weights onto past expenses
