"""
Deployment helper for Bradbury.

Prefer the GenLayer CLI for a first deploy (see README.md §7), but this
script shows the equivalent flow using genlayer-py against the
same JSON-RPC methods, for automation / CI.

Fill in / verify against the current genlayer-py API reference before
running: https://docs.genlayer.com/api-references/genlayer-py/api
(The exact client construction may differ slightly by SDK version —
this script is a starting point, not a guarantee.)
"""

import pathlib

CONTRACT_PATH = pathlib.Path(__file__).parent.parent / "contracts" / "prediction_market.py"

def main():
    try:
        from genlayer_py import create_client
        from genlayer_py.chains import testnet_bradbury
    except ImportError:
        raise SystemExit(
            "pip install genlayer-py, then re-run. "
            "Alternatively use the GenLayer CLI: `genlayer deploy` (see README.md)."
        )

    code = CONTRACT_PATH.read_text()

    client = create_client(chain=testnet_bradbury)
    # A funded Bradbury account is required to pay the creator bond /
    # deployment cost. Import or create one via `genlayer account` and
    # reference it here rather than hardcoding a private key.
    print("Deploying contracts/prediction_market.py to Bradbury...")
    result = client.deploy_contract(
        code=code,
        args={"min_bond_gen": 10, "fee_bps": 100},
    )
    print("Deployed. Contract address:", result.get("contract_address", result))
    print("Update frontend/index.html's window.__PREDICTION_MARKET_ADDRESS__ with this value.")


if __name__ == "__main__":
    main()
