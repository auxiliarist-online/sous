from fastapi import FastAPI

from app.recipes.routes import router as recipes_router

app = FastAPI(title="Sous API", root_path="/api")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


app.include_router(recipes_router)
