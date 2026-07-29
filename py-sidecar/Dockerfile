FROM python:3.12-slim
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng tesseract-ocr-tha \
  && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY boq_parser.py .
COPY boq_contract.py .
COPY boq_source_rows.py .
COPY boq_compound_parser.py .
COPY main.py .
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
