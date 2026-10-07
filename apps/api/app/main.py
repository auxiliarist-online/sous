from fastapi import FastAPI

app = FastAPI(title="Sous API", root_path="/api")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
