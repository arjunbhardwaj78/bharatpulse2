"""One Sarvam AI chat call. Run from the project folder: python sarvam_hello.py

Get your Sarvam AI API subscription key here: https://dashboard.sarvam.ai/admin
"""
import os
from pathlib import Path

from sarvamai import SarvamAI

# Take SARVAM_API_KEY from the environment; if it isn't set there, read it from the .env next to this file.
# The key is never printed.
env_file = Path(__file__).with_name(".env")
if not os.getenv("SARVAM_API_KEY") and env_file.exists():
    for line in env_file.read_text(encoding="utf-8").splitlines():
        name, sep, value = line.partition("=")
        if sep and name.strip() == "SARVAM_API_KEY":
            os.environ["SARVAM_API_KEY"] = value.strip().strip('"').strip("'")

api_key = os.getenv("SARVAM_API_KEY")
if not api_key:
    raise SystemExit("SARVAM_API_KEY is empty. Paste your key into .env (SARVAM_API_KEY=your_key) and run again.")

client = SarvamAI(api_subscription_key=api_key)
response = client.chat.completions(
    model="sarvam-105b-conversations",
    messages=[{"role": "user", "content": "Say hello in Hindi and in English, in one short line."}],
)
print(response.choices[0].message.content)
