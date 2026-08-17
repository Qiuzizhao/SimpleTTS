# SimpleTTS 部署镜像
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV HOST=0.0.0.0
ENV PORT=8000

EXPOSE 8000

# 数据（语音缓存 + 常用短语）持久化在 /app/data，运行时可挂载卷
VOLUME ["/app/data"]

CMD ["python", "server.py"]
