import os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
os.environ["TYPESAFE_API_KEY"] = "fake"
import mock_smoke as mock_test  # builds the handler
import run
from typesafe_sdk import TypeSafeClient
import httpx2
run.TypeSafeClient = lambda **kw: TypeSafeClient(api_key="fake", model=run.MODEL, transport=httpx2.MockTransport(mock_test.handler))
sys.argv = ["run", "--limit", "40", "--workers", "4"]
run.main()
