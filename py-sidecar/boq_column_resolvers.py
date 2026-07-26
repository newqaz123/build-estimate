"""Deterministic column resolvers for known BOQ header structures."""

from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Callable, Sequence


@dataclass(frozen=True)
class ColumnResolution:
    resolver: str
    roles: dict[str, int]


Resolver = Callable[[Sequence[str]], ColumnResolution | None]


def _normal(header: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", header.casefold()).strip()


def _leaf(header: str) -> str:
    return _normal(header.rsplit("/", 1)[-1])


def _unit_cost_component_pairs(headers: Sequence[str]) -> ColumnResolution | None:
    """Resolve shared unit/quantity with material and labour rate/total pairs."""
    normalized = [_normal(str(header or "")) for header in headers]
    leaves = [_leaf(str(header or "")) for header in headers]
    material = [index for index, header in enumerate(normalized) if "material" in header]
    labour = [index for index, header in enumerate(normalized) if "labour" in header]
    if len(material) != 1 or len(labour) != 1:
        return None
    material_rate, labour_rate = material[0], labour[0]
    if material_rate >= labour_rate:
        return None
    material_total, labour_total = material_rate + 1, labour_rate + 1
    if labour_total >= len(headers) or leaves[material_total] != "total" or leaves[labour_total] != "total":
        return None
    if len({material_rate, material_total, labour_rate, labour_total}) != 4:
        return None

    shared_unit = [
        index for index in range(material_rate)
        if leaves[index] in {"unit", "uom", "unit of measure"}
    ]
    shared_qty = [
        index for index in range(material_rate)
        if leaves[index] in {"qty", "q ty", "quantity"}
    ]
    aggregate_amount = [
        index for index in range(labour_total + 1, len(headers))
        if leaves[index] == "amount"
    ]
    if len(shared_unit) != 1 or len(shared_qty) != 1 or len(aggregate_amount) != 1:
        return None

    return ColumnResolution(
        resolver="unit_cost_component_pairs",
        roles={
            "unit": shared_unit[0], "qty": shared_qty[0],
            "material_rate": material_rate, "material_total": material_total,
            "labour_rate": labour_rate, "labour_total": labour_total,
            "amount": aggregate_amount[0],
        },
    )


RESOLVERS: tuple[Resolver, ...] = (_unit_cost_component_pairs,)


def resolve_columns(headers: Sequence[str]) -> ColumnResolution | None:
    for resolver in RESOLVERS:
        resolution = resolver(headers)
        if resolution is not None:
            return resolution
    return None
