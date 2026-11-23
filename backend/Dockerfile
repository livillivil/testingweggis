FROM python:3.11-slim AS builder
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DEFAULT_TIMEOUT=120
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
WORKDIR /build
COPY requirements.txt .
RUN pip install --no-cache-dir --retries 10 --timeout 120 -r requirements.txt

FROM python:3.11-slim AS runner
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
RUN groupadd -g 10001 kmcuser \
    && useradd -u 10001 -g kmcuser -s /sbin/nologin -m kmcuser \
    && mkdir -p /app /tileserver-data/temp /uploads/offline_bundles /app/uploads/offline_bundles \
    && chown -R kmcuser:kmcuser /app /tileserver-data /uploads \
    && chmod -R u+rwX /tileserver-data /uploads /app/uploads
WORKDIR /app
COPY --from=builder /opt/venv /opt/venv
COPY --chown=kmcuser:kmcuser ./app /app/app
USER kmcuser
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "4"]
