# Config-only: not built/run in this environment (no Docker installed locally).
#
# Build:
#   docker build -t aps/optimization-solver services/optimization-solver
# Run:
#   docker run -p 4007:4007 aps/optimization-solver

FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

EXPOSE 4007
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "4007"]
