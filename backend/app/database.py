"""SQLAlchemy database setup with User and Generation models."""

import uuid
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import (
    create_engine, Column, String, Integer, Float, Text, DateTime, ForeignKey, Boolean, event
)
from sqlalchemy.orm import declarative_base, sessionmaker, relationship

# Ensure data directory exists
DATA_DIR = Path(__file__).parent.parent / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

DATABASE_URL = f"sqlite:///{DATA_DIR / 'voxmidi.db'}"

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False},  # needed for SQLite in FastAPI
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class User(Base):
    __tablename__ = "users"

    id = Column(String, primary_key=True)  # Clerk user ID (sub)
    email = Column(String, index=True)
    name = Column(String, default="")
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    usage_count = Column(Integer, default=0)
    usage_limit = Column(Integer, default=50)
    usage_reset_month = Column(Integer, default=0)  # month number 1-12

    generations = relationship("Generation", back_populates="user", lazy="dynamic")


class Generation(Base):
    __tablename__ = "generations"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4())[:8])
    user_id = Column(String, ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    mode = Column(String, default="text")          # text | voice | source
    genre = Column(String, default="edm")
    tempo = Column(Integer, default=128)
    key = Column(String, default="Am")
    prompt = Column(Text, default="")
    midi_filename = Column(String, default="")
    tracks_count = Column(Integer, default=0)
    replicate_cost = Column(Float, default=0.0)
    duration = Column(Float, default=0.0)
    time_signature = Column(String, default="4/4")
    is_favorite = Column(Boolean, default=False)
    is_shared = Column(Boolean, default=False)
    parent_job_id = Column(String, nullable=True)
    remix_count = Column(Integer, default=0)

    user = relationship("User", back_populates="generations")


class Preset(Base):
    __tablename__ = "presets"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4())[:8])
    user_id = Column(String, ForeignKey("users.id"), nullable=False)
    name = Column(String, default="")
    genre = Column(String, default="pop")
    tempo = Column(Integer, default=120)
    key = Column(String, default="Am")
    prompt_prefix = Column(Text, default="")
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    Base.metadata.create_all(bind=engine)
