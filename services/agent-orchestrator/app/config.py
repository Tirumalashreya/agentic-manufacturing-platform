# app/config.py
# One place for values every agent needs — change once here instead of in
# every agent file. Groq's hosted model catalog changes over time (this
# exact problem just happened: llama-3.3-70b-versatile got removed), so
# this is the one line to fix next time, not N agent files.
GROQ_MODEL = "openai/gpt-oss-120b"

import os


# Groq's rate limit (tokens/day) is scoped per organization, not per key —
# so spreading agents across separate accounts actually adds capacity,
# unlike generating multiple keys from the same account. Each agent can
# get its own dedicated key (GROQ_API_KEY_<AGENT>); anything without one
# falls back to the shared GROQ_API_KEY, so this works with just one key
# too.
def groq_api_key(agent_name: str) -> str:
    return os.environ.get(f"GROQ_API_KEY_{agent_name.upper()}") or os.environ["GROQ_API_KEY"]
