#!/usr/bin/env python3
"""
Get Moomoo option snapshots with option-specific fields needed for pre-trade analysis.

Usage:
  python get_moomoo_option_snapshots.py US.AAPL260515C240000 US.AAPL260515P240000 --json
"""
import argparse
import json
import math
import os
import sys

from moomoo import OpenQuoteContext


def safe_get(row, key, default=None):
    try:
        value = row[key]
    except Exception:
        try:
            value = getattr(row, key)
        except Exception:
            return default

    if value is None:
        return default
    try:
        if isinstance(value, float) and math.isnan(value):
            return default
    except Exception:
        pass
    return value


def safe_float(value, default=None):
    try:
        numeric = float(value)
        if math.isnan(numeric):
            return default
        return numeric
    except Exception:
        return default


def safe_int(value, default=None):
    try:
        numeric = int(float(value))
        return numeric
    except Exception:
        return default


def main():
    parser = argparse.ArgumentParser(description="Get option snapshots with OI/Greeks")
    parser.add_argument("codes", nargs="+", help="Option codes, e.g. US.AAPL260515C240000")
    parser.add_argument("--json", action="store_true", dest="output_json", help="Output JSON")
    args = parser.parse_args()

    host = os.getenv("FUTU_OPEND_HOST", "127.0.0.1")
    port = int(os.getenv("FUTU_OPEND_PORT", "11111"))
    ctx = None
    try:
        ctx = OpenQuoteContext(host=host, port=port)
        ret, data = ctx.get_market_snapshot(args.codes)
        if ret != 0:
            raise RuntimeError(str(data))

        records = []
        for index in range(len(data)):
            row = data.iloc[index] if hasattr(data, "iloc") else data[index]
            records.append({
                "code": safe_get(row, "code", ""),
                "name": safe_get(row, "name", ""),
                "stock_owner": safe_get(row, "stock_owner", ""),
                "option_type": safe_get(row, "option_type", ""),
                "strike_time": safe_get(row, "strike_time", ""),
                "option_strike_price": safe_float(safe_get(row, "option_strike_price")),
                "last_price": safe_float(safe_get(row, "last_price")),
                "bid_price": safe_float(safe_get(row, "bid_price")),
                "ask_price": safe_float(safe_get(row, "ask_price")),
                "price_spread": safe_float(safe_get(row, "price_spread")),
                "volume": safe_int(safe_get(row, "volume")),
                "option_open_interest": safe_int(safe_get(row, "option_open_interest")),
                "option_implied_volatility": safe_float(safe_get(row, "option_implied_volatility")),
                "option_delta": safe_float(safe_get(row, "option_delta")),
                "option_gamma": safe_float(safe_get(row, "option_gamma")),
                "option_theta": safe_float(safe_get(row, "option_theta")),
                "option_vega": safe_float(safe_get(row, "option_vega")),
                "option_rho": safe_float(safe_get(row, "option_rho")),
                "update_time": safe_get(row, "update_time", ""),
            })

        if args.output_json:
            print(json.dumps({"data": records}, ensure_ascii=False))
        else:
            print(json.dumps({"data": records}, ensure_ascii=False, indent=2))
    except Exception as exc:
        if args.output_json:
            print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        else:
            print(f"Error: {exc}")
        sys.exit(1)
    finally:
        if ctx is not None:
            ctx.close()


if __name__ == "__main__":
    main()
