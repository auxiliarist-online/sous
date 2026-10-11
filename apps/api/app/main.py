from fastapi import FastAPI

from app.plans.routes import router as plans_router
from app.recipes.routes import router as recipes_router

app = FastAPI(title="Sous API", root_path="/api")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


app.include_router(recipes_router)
app.include_router(plans_router)
