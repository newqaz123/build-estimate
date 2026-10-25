FROM python:3.12-slim
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
  && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cpu -r requirements.txt
COPY boq_parser.py .
COPY boq_contract.py .
COPY boq_source_rows.py .
COPY boq_compound_parser.py .
COPY boq_column_resolvers.py .
COPY header_terms.py .
COPY page_normalizer.py .
COPY table_geometry.py .
COPY pdf_text_layer.py .
COPY document_summary.py .
COPY main.py .
COPY warmup.py .
RUN python warmup.py
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
