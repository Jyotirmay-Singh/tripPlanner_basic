from typing import List, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


TripDeletionAction = Literal["keep", "leave", "dissolve_family"]


class AccountTripAction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    trip_id: str = Field(min_length=1)
    action: TripDeletionAction

    @field_validator("trip_id")
    @classmethod
    def _clean_trip_id(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("trip_id is required")
        return cleaned


class AccountDeletionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    confirmation: str
    acknowledge_unsettled: bool
    trip_actions: List[AccountTripAction] = Field(default_factory=list)

    @model_validator(mode="after")
    def _unique_trip_actions(self):
        trip_ids = [item.trip_id for item in self.trip_actions]
        if len(trip_ids) != len(set(trip_ids)):
            raise ValueError("Each trip may appear only once in trip_actions")
        return self


class MembershipDepartureIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    dissolve_family: bool = False
