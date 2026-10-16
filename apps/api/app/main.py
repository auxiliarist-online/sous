from fastapi import FastAPI

from app.errors import report_errors, reporter
from app.feedback.routes import router as feedback_router
from app.plans.routes import router as plans_router
from app.recipes.routes import router as recipes_router
from app.stores.routes import router as stores_router

app = FastAPI(title="Sous API", root_path="/api")
report_errors(app, reporter())


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


app.include_router(recipes_router)
app.include_router(plans_router)
app.include_router(stores_router)
app.include_router(feedback_router)
