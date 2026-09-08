#!/usr/bin/env python3
"""DATU workbench backend: SQLite persistence and a lightweight JSON API."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import mimetypes
import os
import secrets
import sqlite3
import threading
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import unquote, urlparse


BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
DEFAULT_DB_PATH = BASE_DIR / "data" / "datu.db"
SESSION_COOKIE = "datu_session"
SESSION_TTL_DAYS = 30
PRIORITY_ORDER = {"urgent_important": 0, "important_not_urgent": 1, "urgent_not_important": 2, "normal": 3}


def db_path() -> Path:
    return Path(os.environ.get("DATU_DB", str(DEFAULT_DB_PATH))).resolve()


def to_date(value: str | None, fallback: date | None = None) -> date | None:
    if not value:
        return fallback
    try:
        return date.fromisoformat(value[:10])
    except (ValueError, TypeError):
        return fallback


def iso_date(value: date | None = None) -> str:
    return (value or date.today()).isoformat()


def monday_of(value: date | None = None) -> date:
    value = value or date.today()
    return value - timedelta(days=value.weekday())


def hash_password(password: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 260_000)
    return f"{salt}${digest.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        salt, digest = encoded.split("$", 1)
        expected = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 260_000)
        return hmac.compare_digest(expected.hex(), digest)
    except (ValueError, TypeError):
        return False


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self.initialize()

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            connection = sqlite3.connect(self.path, timeout=10)
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA foreign_keys = ON")
            connection.execute("PRAGMA journal_mode = WAL")
            try:
                yield connection
                connection.commit()
            except Exception:
                connection.rollback()
                raise
            finally:
                connection.close()

    def initialize(self) -> None:
        schema = """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            display_name TEXT NOT NULL DEFAULT '',
            seeded INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'normal',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS goals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            content TEXT NOT NULL DEFAULT '',
            due_date TEXT,
            status TEXT NOT NULL DEFAULT 'in_progress',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
            goal_id INTEGER REFERENCES goals(id) ON DELETE CASCADE,
            project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
            team_goal_id INTEGER REFERENCES team_goals(id) ON DELETE SET NULL,
            title TEXT NOT NULL,
            priority TEXT NOT NULL DEFAULT 'normal',
            due_date TEXT NOT NULL,
            content TEXT NOT NULL DEFAULT '',
            blocked INTEGER NOT NULL DEFAULT 0,
            done INTEGER NOT NULL DEFAULT 0,
            postponed_count INTEGER NOT NULL DEFAULT 0,
            completed_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'in_progress',
            start_date TEXT,
            due_date TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS team_members (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'normal',
            strengths TEXT NOT NULL DEFAULT '',
            risks TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ideas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            title TEXT NOT NULL DEFAULT '',
            content TEXT NOT NULL,
            tags TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS team_goals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            period TEXT NOT NULL,
            title TEXT NOT NULL,
            objectives TEXT NOT NULL DEFAULT '',
            plan TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'in_progress',
            due_date TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS team_progress (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            goal_id INTEGER NOT NULL REFERENCES team_goals(id) ON DELETE CASCADE,
            week_start TEXT NOT NULL,
            result TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'in_progress',
            blockers TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(goal_id, week_start)
        );
        CREATE INDEX IF NOT EXISTS idx_tasks_user_due ON tasks(user_id, due_date);
        CREATE INDEX IF NOT EXISTS idx_ideas_user ON ideas(user_id);
        CREATE INDEX IF NOT EXISTS idx_team_progress_user ON team_progress(user_id);
        """
        with self.connect() as connection:
            connection.executescript(schema)
            task_columns = {row[1] for row in connection.execute("PRAGMA table_info(tasks)")}
            if "content" not in task_columns:
                connection.execute("ALTER TABLE tasks ADD COLUMN content TEXT NOT NULL DEFAULT ''")
            if "project_id" not in task_columns:
                connection.execute("ALTER TABLE tasks ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL")
            if "team_goal_id" not in task_columns:
                connection.execute("ALTER TABLE tasks ADD COLUMN team_goal_id INTEGER REFERENCES team_goals(id) ON DELETE SET NULL")
            if "goal_id" not in task_columns:
                connection.execute("ALTER TABLE tasks ADD COLUMN goal_id INTEGER REFERENCES goals(id) ON DELETE CASCADE")

    def rollover_tasks(self, user_id: int, today: date | None = None) -> int:
        today = today or date.today()
        with self.connect() as connection:
            cursor = connection.execute(
                """
                UPDATE tasks
                SET due_date = ?, postponed_count = postponed_count + 1, updated_at = ?
                WHERE user_id = ? AND done = 0 AND date(due_date) < ?
                """,
                (iso_date(today), datetime.now().isoformat(timespec="seconds"), user_id, iso_date(today)),
            )
            return cursor.rowcount or 0


DATABASE: Database | None = None


def get_database() -> Database:
    global DATABASE
    if DATABASE is None:
        DATABASE = Database(db_path())
    return DATABASE


def seed_default_user(database: Database) -> None:
    username = os.environ.get("DATU_ADMIN_USER", "admin")
    password = os.environ.get("DATU_ADMIN_PASSWORD", "datu123456")
    display_name = os.environ.get("DATU_ADMIN_NAME", "运维团队负责人")
    with database.connect() as connection:
        user = connection.execute("SELECT id, seeded FROM users WHERE username = ?", (username,)).fetchone()
        if user is None:
            cursor = connection.execute(
                "INSERT INTO users(username, password, display_name, created_at) VALUES(?,?,?,?)",
                (username, hash_password(password), display_name, datetime.now().isoformat(timespec="seconds")),
            )
            user_id = int(cursor.lastrowid)
            seeded = False
        else:
            user_id = int(user["id"])
            seeded = bool(user["seeded"])
    if seeded:
        return
    seed_user_data(user_id)
    with database.connect() as connection:
        connection.execute("UPDATE users SET seeded = 1 WHERE id = ?", (user_id,))


def seed_user_data(user_id: int) -> None:
    now = datetime.now().isoformat(timespec="seconds")
    today = date.today()
    yesterday = today - timedelta(days=1)
    future_1 = today + timedelta(days=2)
    future_2 = today + timedelta(days=5)
    with get_database().connect() as connection:
        categories = [
            ("系统巡检", "核心系统健康检查、备份验证、告警治理与例行变更。", "normal"),
            ("故障演练", "季度灾备切换与常见故障场景演练。", "attention"),
            ("团队培养", "值班能力地图、技能轮训和知识库沉淀。", "normal"),
        ]
        for name, description, status in categories:
            connection.execute(
                "INSERT INTO categories(user_id,name,description,status,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                (user_id, name, description, status, now, now),
            )
        tasks = [
            ("处理生产磁盘告警并复核清理策略", "urgent_important", today, 1, 1, 2),
            ("完成上周未关闭的备份恢复验证", "urgent_important", yesterday, 0, 1, 1),
            ("梳理 12 个核心服务的监控阈值", "important_not_urgent", today, 0, 0, 0),
            ("输出 Linux 性能排查培训大纲", "important_not_urgent", future_1, 0, 0, 0),
            ("与网络组确认 VPN 优化方案", "urgent_not_important", future_2, 0, 0, 0),
            ("整理值班手册常见问题", "normal", today, 0, 0, 0),
        ]
        for title, priority, due, done, blocked, postpone in tasks:
            connection.execute(
                """
                INSERT INTO tasks(user_id,category_id,title,priority,due_date,blocked,done,postponed_count,
                                  completed_at,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?)
                """,
                (user_id, (1 if "磁盘" in title else 2 if "演练" in title else 3), title, priority,
                 iso_date(due), blocked, done, postpone,
                 now if done else None, now, now),
            )
        ideas = [
            ("值班自动问答", "把常见告警处置步骤整理成值班机器人可检索的问答库。", "自动化,知识库"),
            ("月度健康评分", "用可用性、变更成功率、告警时长三个维度给系统打分。", "可视化,运维指标"),
        ]
        for title, content, tags in ideas:
            connection.execute(
                "INSERT INTO ideas(user_id,title,content,tags,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                (user_id, title, content, tags, now, now),
            )
        goals = [
            ("monthly", "9 月：降噪与值守体验提升", "告警降噪 30%；值班响应手册更新；完成一次桌面演练。",
             "第1周盘点高频告警；第2周落地压缩规则；第3周演练并复盘。", "in_progress", iso_date(today + timedelta(days=20))),
            ("quarterly", "Q3：打造可复制的运维能力", "建立分级响应机制，沉淀 20 篇标准处置文档，开展 2 次故障演练。",
             "按月推进：能力地图 → 训练 → 演练 → 指标复盘。", "in_progress", iso_date(today + timedelta(days=45))),
        ]
        for period, title, objectives, plan, status, due in goals:
            connection.execute(
                "INSERT INTO team_goals(user_id,period,title,objectives,plan,status,due_date,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
                (user_id, period, title, objectives, plan, status, due, now, now),
            )
        connection.execute(
            """
            INSERT INTO team_progress(user_id,goal_id,week_start,result,status,blockers,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?)
            """,
            (user_id, 1, iso_date(monday_of(today)), "完成高频告警清单，压缩 42 条重复告警。", "in_progress",
             "日志平台字段统一尚未完成，影响规则灰度。", now, now),
        )


        projects = [
            ("监控系统治理", "统一告警阈值、降噪规则和值班视图，提升故障发现效率。", "in_progress", iso_date(today - timedelta(days=12)), iso_date(today + timedelta(days=20))),
            ("备份恢复演练", "验证核心数据库和对象存储恢复链路，形成季度演练报告。", "in_progress", iso_date(today - timedelta(days=5)), iso_date(today + timedelta(days=35))),
        ]
        for name, description, status, start, due in projects:
            connection.execute(
                "INSERT INTO projects(user_id,name,description,status,start_date,due_date,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                (user_id, name, description, status, start, due, now, now),
            )
        connection.execute(
            """
            UPDATE tasks SET project_id = CASE
                WHEN title LIKE '%监控%' OR title LIKE '%告警%' THEN (SELECT id FROM projects WHERE name = '监控系统治理')
                WHEN title LIKE '%备份%' THEN (SELECT id FROM projects WHERE name = '备份恢复演练')
                ELSE project_id
            END WHERE user_id = ?
            """, (user_id,))
        members = [
            ("李明", "值班工程师", "normal", "Linux 排障熟练，善于沉淀手册。", "希望加强数据库深水区能力。"),
            ("王强", "网络运维", "attention", "网络链路分析能力强。", "近期值班负荷较高，需要轮换。"),
            ("赵云", "平台运维", "normal", "自动化开发能力突出。", "文档输出节奏可以再提升。"),
        ]
        for name, role, status, strengths, risks in members:
            connection.execute(
                "INSERT INTO team_members(user_id,name,role,status,strengths,risks,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                (user_id, name, role, status, strengths, risks, now, now),
            )
def auth_user(connection: sqlite3.Connection, token: str | None) -> sqlite3.Row | None:
    if not token:
        return None
    row = connection.execute(
        """
        SELECT u.id, u.username, u.display_name
        FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token = ? AND s.expires_at > ?
        """,
        (token, datetime.now().isoformat(timespec="seconds")),
    ).fetchone()
    return row


def clean_text(value: Any, max_length: int = 10_000) -> str:
    if value is None:
        return ""
    return str(value).strip()[:max_length]


def normalize_task(row: sqlite3.Row) -> dict[str, Any]:
    return dict(row) | {
        "done": bool(row["done"]),
        "blocked": bool(row["blocked"]),
        "overdue": False,
    }


def user_payload(user_id: int) -> dict[str, Any]:
    database = get_database()
    database.rollover_tasks(user_id)
    today = iso_date()
    with database.connect() as connection:
        categories = [dict(row) for row in connection.execute(
            """
            SELECT c.*,
              (SELECT COUNT(*) FROM tasks t WHERE t.category_id = c.id AND t.done = 1) AS done_count,
              (SELECT COUNT(*) FROM tasks t WHERE t.category_id = c.id) AS total_count
            FROM categories c WHERE c.user_id = ? ORDER BY c.name COLLATE NOCASE
            """, (user_id,))]
        tasks = [normalize_task(row) for row in connection.execute(
            "SELECT * FROM tasks WHERE user_id = ? ORDER BY due_date, priority, id", (user_id,))]
        for task in tasks:
            task["overdue"] = not task["done"] and task["due_date"] < today
        ideas = [dict(row) for row in connection.execute(
            "SELECT * FROM ideas WHERE user_id = ? ORDER BY created_at DESC, id DESC", (user_id,))]
        goals = [dict(row) for row in connection.execute(
            """
            SELECT g.*,
              (SELECT COUNT(*) FROM tasks t WHERE t.goal_id = g.id) AS total_count,
              (SELECT COUNT(*) FROM tasks t WHERE t.goal_id = g.id AND t.done = 1) AS done_count
            FROM goals g WHERE g.user_id = ? ORDER BY g.created_at, g.id
            """, (user_id,))]
        projects = [dict(row) for row in connection.execute(
            """
            SELECT p.*,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS total_count,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.done = 1) AS done_count
            FROM projects p WHERE p.user_id = ? ORDER BY p.created_at, p.id
            """, (user_id,))]
        team_goals = [dict(row) for row in connection.execute(
            """
            SELECT g.*,
              (SELECT COUNT(*) FROM tasks t WHERE t.team_goal_id = g.id) AS total_count,
              (SELECT COUNT(*) FROM tasks t WHERE t.team_goal_id = g.id AND t.done = 1) AS done_count
            FROM team_goals g WHERE g.user_id = ? ORDER BY g.due_date, g.id
            """, (user_id,))]
        team_progress = [dict(row) for row in connection.execute(
            "SELECT * FROM team_progress WHERE user_id = ? ORDER BY week_start DESC, id DESC", (user_id,))]
        team_members = [dict(row) for row in connection.execute(
            "SELECT * FROM team_members WHERE user_id = ? ORDER BY name COLLATE NOCASE, id", (user_id,))]
    return {"today": today, "weekStart": iso_date(monday_of()), "categories": categories, "goals": goals,
            "projects": projects, "tasks": tasks, "ideas": ideas, "teamGoals": team_goals,
            "teamProgress": team_progress, "teamMembers": team_members}


class Handler(BaseHTTPRequestHandler):
    server_version = "DatuServer/1.0"

    @property
    def database(self) -> Database:
        return get_database()

    def log_message(self, format: str, *args: Any) -> None:
        if os.environ.get("DATU_ACCESS_LOG", "0") == "1":
            super().log_message(format, *args)

    def read_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length <= 0 or length > 10 * 1024 * 1024:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ValueError("请求体不是有效 JSON")

    def session_token(self) -> str | None:
        cookie = self.headers.get("Cookie", "")
        for part in cookie.split(";"):
            if part.strip().startswith(SESSION_COOKIE + "="):
                return unquote(part.strip().split("=", 1)[1])
        return None

    def send_json(self, status: int, payload: Any, set_cookie: str | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if set_cookie:
            self.send_header("Set-Cookie", set_cookie)
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path: Path) -> None:
        if not path.is_file():
            self.send_json(404, {"error": "页面不存在"})
            return
        content_type, _ = mimetypes.guess_type(str(path))
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def redirect(self, location: str) -> None:
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        if path.startswith("/api/"):
            self.handle_api("GET", path)
            return
        if path in {"/", "/index.html", "/login"}:
            self.send_file(FRONTEND_DIR / "index.html")
            return
        relative = path.lstrip("/")
        target = (FRONTEND_DIR / relative).resolve()
        try:
            target.relative_to(FRONTEND_DIR)
        except ValueError:
            self.send_json(403, {"error": "非法路径"})
            return
        self.send_file(target)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        self.handle_api("POST", parsed.path.rstrip("/") or "/")

    def do_PUT(self) -> None:
        parsed = urlparse(self.path)
        self.handle_api("PUT", parsed.path.rstrip("/") or "/")

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        self.handle_api("DELETE", parsed.path.rstrip("/") or "/")

    def handle_api(self, method: str, path: str) -> None:
        try:
            if method == "POST" and path == "/api/login":
                self.handle_login()
                return
            if method == "POST" and path == "/api/logout":
                self.handle_logout()
                return
            with self.database.connect() as connection:
                user = auth_user(connection, self.session_token())
                if user is None:
                    self.send_json(401, {"error": "请先登录"})
                    return
                user_id = int(user["id"])
                if method == "GET" and path == "/api/me":
                    self.send_json(200, {"id": user_id, "username": user["username"], "displayName": user["display_name"]})
                    return
                if method == "GET" and path == "/api/workspace":
                    self.send_json(200, user_payload(user_id))
                    return
                if method == "GET" and path == "/api/export":
                    with self.database.connect() as export_connection:
                        payload = export_backup(export_connection, user_id)
                    self.send_json(200, payload)
                    return
                if method == "POST" and path == "/api/import":
                    self.handle_import(user_id)
                    return
                if method == "POST" and path == "/api/examples/clear":
                    clear_examples(user_id)
                    self.send_json(200, {"ok": True, "message": "示例数据已清空"})
                    return
                match method:
                    case "POST":
                        self.handle_create(user_id, path)
                    case "PUT":
                        self.handle_update(user_id, path)
                    case "DELETE":
                        self.handle_delete(user_id, path)
                    case _:
                        self.send_json(405, {"error": "方法不支持"})
        except ValueError as error:
            self.send_json(400, {"error": str(error)})
        except sqlite3.IntegrityError:
            self.send_json(409, {"error": "数据冲突，请刷新后重试"})
        except Exception:
            self.send_json(500, {"error": "服务内部错误"})
            if os.environ.get("DATU_DEBUG") == "1":
                raise

    def handle_login(self) -> None:
        body = self.read_body()
        username = clean_text(body.get("username"), 100)
        password = str(body.get("password", ""))
        if not username or not password:
            self.send_json(400, {"error": "请输入用户名和密码"})
            return
        with self.database.connect() as connection:
            user = connection.execute("SELECT id, password FROM users WHERE username = ?", (username,)).fetchone()
            if user is None or not verify_password(password, user["password"]):
                self.send_json(401, {"error": "用户名或密码错误"})
                return
            token = secrets.token_urlsafe(32)
            expires = datetime.now() + timedelta(days=SESSION_TTL_DAYS)
            connection.execute(
                "INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)",
                (token, int(user["id"]), expires.isoformat(timespec="seconds")),
            )
        cookie = f"{SESSION_COOKIE}={token}; HttpOnly; Path=/; Max-Age={SESSION_TTL_DAYS * 86400}; SameSite=Lax"
        self.send_json(200, {"ok": True}, set_cookie=cookie)

    def handle_logout(self) -> None:
        token = self.session_token()
        if token:
            with self.database.connect() as connection:
                connection.execute("DELETE FROM sessions WHERE token = ?", (token,))
        cookie = f"{SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax"
        self.send_json(200, {"ok": True}, set_cookie=cookie)

    def handle_import(self, user_id: int) -> None:
        body = self.read_body()
        data = body.get("data")
        if not isinstance(data, dict):
            raise ValueError("备份文件格式不正确")
        if data.get("kind") != "datu-workbench-backup":
            raise ValueError("不是 DATU 工作台备份文件")
        imported = import_backup(user_id, data)
        self.send_json(200, {"ok": True, **imported, "workspace": user_payload(user_id)})

    def handle_create(self, user_id: int, path: str) -> None:
        body = self.read_body()
        now = datetime.now().isoformat(timespec="seconds")
        route = {
            "/api/tasks": self.create_task,
            "/api/categories": self.create_category,
            "/api/goals": self.create_goal,
            "/api/projects": self.create_project,
            "/api/team-members": self.create_team_member,
            "/api/ideas": self.create_idea,
            "/api/team-goals": self.create_team_goal,
            "/api/team-progress": self.create_team_progress,
        }
        function = route.get(path)
        if function is None:
            self.send_json(404, {"error": "接口不存在"})
            return
        record = function(user_id, body, now)
        self.send_json(201, {"ok": True, "record": record, "workspace": user_payload(user_id)})

    def create_task(self, user_id: int, body: dict[str, Any], now: str) -> dict[str, Any]:
        title = clean_text(body.get("title"), 300)
        if not title:
            raise ValueError("任务内容不能为空")
        due = to_date(body.get("dueDate"))
        if due is None:
            raise ValueError("截止日期无效")
        priority = clean_text(body.get("priority"), 50) or "normal"
        category_id = int(body["categoryId"]) if body.get("categoryId") not in (None, "", 0) else None
        goal_id = int(body["goalId"]) if body.get("goalId") not in (None, "", 0) else None
        project_id = int(body["projectId"]) if body.get("projectId") not in (None, "", 0) else None
        team_goal_id = int(body["teamGoalId"]) if body.get("teamGoalId") not in (None, "", 0) else None
        with self.database.connect() as connection:
            if goal_id:
                goal = connection.execute("SELECT category_id FROM goals WHERE id=? AND user_id=?", (goal_id, user_id)).fetchone()
                if goal is None:
                    raise ValueError("任务目标不存在")
                category_id = int(goal["category_id"])
            if project_id and connection.execute("SELECT 1 FROM projects WHERE id=? AND user_id=?", (project_id, user_id)).fetchone() is None:
                raise ValueError("项目不存在")
            if team_goal_id and connection.execute("SELECT 1 FROM team_goals WHERE id=? AND user_id=?", (team_goal_id, user_id)).fetchone() is None:
                raise ValueError("团队目标不存在")
            cursor = connection.execute(
                """
                INSERT INTO tasks(user_id,category_id,goal_id,project_id,team_goal_id,title,priority,due_date,content,blocked,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (user_id, category_id, goal_id, project_id, team_goal_id, title, priority, iso_date(due),
                 clean_text(body.get("content"), 20000), 1 if body.get("blocked") else 0, now, now),
            )
            return {"id": int(cursor.lastrowid)}

    def create_category(self, user_id: int, body: dict[str, Any], now: str) -> dict[str, Any]:
        name = clean_text(body.get("name"), 120)
        if not name:
            raise ValueError("分类名称不能为空")
        with self.database.connect() as connection:
            cursor = connection.execute(
                "INSERT INTO categories(user_id,name,description,status,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                (user_id, name, clean_text(body.get("description"), 5000), clean_text(body.get("status"), 30) or "normal", now, now),
            )
            return {"id": int(cursor.lastrowid)}

    def create_goal(self, user_id: int, body: dict[str, Any], now: str) -> dict[str, Any]:
        title = clean_text(body.get("title"), 300)
        if not title:
            raise ValueError("目标名称不能为空")
        category_id = int(body.get("categoryId") or 0)
        if category_id <= 0:
            raise ValueError("请选择工作分类")
        due = to_date(body.get("dueDate"))
        with self.database.connect() as connection:
            exists = connection.execute("SELECT 1 FROM categories WHERE id=? AND user_id=?", (category_id, user_id)).fetchone()
            if not exists:
                raise ValueError("工作分类不存在")
            cursor = connection.execute(
                "INSERT INTO goals(user_id,category_id,title,content,due_date,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                (user_id, category_id, title, clean_text(body.get("content"), 20000), iso_date(due) if due else None,
                 clean_text(body.get("status"), 30) or "in_progress", now, now),
            )
            return {"id": int(cursor.lastrowid)}

    def create_project(self, user_id: int, body: dict[str, Any], now: str) -> dict[str, Any]:
        name = clean_text(body.get("name"), 200)
        if not name:
            raise ValueError("项目名称不能为空")
        start = to_date(body.get("startDate"))
        due = to_date(body.get("dueDate"))
        with self.database.connect() as connection:
            cursor = connection.execute(
                """
                INSERT INTO projects(user_id,name,description,status,start_date,due_date,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?,?)
                """,
                (user_id, name, clean_text(body.get("description"), 5000),
                 clean_text(body.get("status"), 30) or "in_progress", iso_date(start) if start else None,
                 iso_date(due) if due else None, now, now),
            )
            return {"id": int(cursor.lastrowid)}

    def create_team_member(self, user_id: int, body: dict[str, Any], now: str) -> dict[str, Any]:
        name = clean_text(body.get("name"), 120)
        if not name:
            raise ValueError("成员姓名不能为空")
        with self.database.connect() as connection:
            cursor = connection.execute(
                """
                INSERT INTO team_members(user_id,name,role,status,strengths,risks,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?,?)
                """,
                (user_id, name, clean_text(body.get("role"), 120), clean_text(body.get("status"), 30) or "normal",
                 clean_text(body.get("strengths"), 5000), clean_text(body.get("risks"), 5000), now, now),
            )
            return {"id": int(cursor.lastrowid)}

    def create_idea(self, user_id: int, body: dict[str, Any], now: str) -> dict[str, Any]:
        content = clean_text(body.get("content"), 5000)
        if not content:
            raise ValueError("想法内容不能为空")
        tags = clean_text(body.get("tags"), 500)
        with self.database.connect() as connection:
            cursor = connection.execute(
                "INSERT INTO ideas(user_id,title,content,tags,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                (user_id, clean_text(body.get("title"), 200) or content[:30], content, tags, now, now),
            )
            return {"id": int(cursor.lastrowid)}

    def create_team_goal(self, user_id: int, body: dict[str, Any], now: str) -> dict[str, Any]:
        title = clean_text(body.get("title"), 300)
        if not title:
            raise ValueError("目标名称不能为空")
        due = to_date(body.get("dueDate"))
        with self.database.connect() as connection:
            cursor = connection.execute(
                "INSERT INTO team_goals(user_id,period,title,objectives,plan,status,due_date,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
                (user_id, clean_text(body.get("period"), 30) or "monthly", title, clean_text(body.get("objectives"), 5000),
                 clean_text(body.get("plan"), 5000), clean_text(body.get("status"), 30) or "in_progress",
                 iso_date(due) if due else None, now, now),
            )
            return {"id": int(cursor.lastrowid)}

    def create_team_progress(self, user_id: int, body: dict[str, Any], now: str) -> dict[str, Any]:
        goal_id = int(body.get("goalId") or 0)
        if goal_id <= 0:
            raise ValueError("请选择团队目标")
        week_start = to_date(body.get("weekStart"), monday_of())
        with self.database.connect() as connection:
            exists = connection.execute("SELECT 1 FROM team_goals WHERE id=? AND user_id=?", (goal_id, user_id)).fetchone()
            if not exists:
                raise ValueError("团队目标不存在")
            cursor = connection.execute(
                """
                INSERT INTO team_progress(user_id,goal_id,week_start,result,status,blockers,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?,?)
                ON CONFLICT(goal_id, week_start) DO UPDATE SET
                  result=excluded.result,status=excluded.status,blockers=excluded.blockers,updated_at=excluded.updated_at
                """,
                (user_id, goal_id, iso_date(week_start), clean_text(body.get("result"), 5000),
                 clean_text(body.get("status"), 30) or "in_progress", clean_text(body.get("blockers"), 5000), now, now),
            )
            return {"id": int(cursor.lastrowid)}

    def handle_update(self, user_id: int, path: str) -> None:
        parts = path.split("/")
        if len(parts) != 4 or parts[1] != "api":
            self.send_json(404, {"error": "接口不存在"})
            return
        table = {"tasks": "tasks", "categories": "categories", "goals": "goals", "projects": "projects",
                 "team-members": "team_members", "ideas": "ideas",
                 "team-goals": "team_goals", "team-progress": "team_progress"}.get(parts[2])
        if table is None:
            self.send_json(404, {"error": "接口不存在"})
            return
        record_id = int(parts[3])
        body = self.read_body()
        updates = normalize_update(table, body)
        if not updates:
            self.send_json(400, {"error": "没有可更新字段"})
            return
        set_clause = ", ".join(f"{key} = ?" for key in updates)
        values = list(updates.values()) + [record_id, user_id]
        with self.database.connect() as connection:
            cursor = connection.execute(f"UPDATE {table} SET {set_clause} WHERE id = ? AND user_id = ?", values)
            if cursor.rowcount == 0:
                self.send_json(404, {"error": "记录不存在"})
                return
        self.send_json(200, {"ok": True, "workspace": user_payload(user_id)})

    def handle_delete(self, user_id: int, path: str) -> None:
        parts = path.split("/")
        if len(parts) != 4 or parts[1] != "api":
            self.send_json(404, {"error": "接口不存在"})
            return
        table = {"tasks": "tasks", "categories": "categories", "goals": "goals", "projects": "projects",
                 "team-members": "team_members", "ideas": "ideas",
                 "team-goals": "team_goals", "team-progress": "team_progress"}.get(parts[2])
        if table is None:
            self.send_json(404, {"error": "接口不存在"})
            return
        record_id = int(parts[3])
        with self.database.connect() as connection:
            cursor = connection.execute(f"DELETE FROM {table} WHERE id = ? AND user_id = ?", (record_id, user_id))
            if cursor.rowcount == 0:
                self.send_json(404, {"error": "记录不存在"})
                return
        self.send_json(200, {"ok": True, "workspace": user_payload(user_id)})


def normalize_update(table: str, body: dict[str, Any]) -> dict[str, Any]:
    now = datetime.now().isoformat(timespec="seconds")
    updates: dict[str, Any] = {"updated_at": now}
    if table == "tasks":
        if "title" in body:
            title = clean_text(body["title"], 300)
            if not title:
                raise ValueError("任务内容不能为空")
            updates["title"] = title
        if "priority" in body:
            updates["priority"] = clean_text(body["priority"], 50) or "normal"
        if "dueDate" in body:
            due = to_date(body["dueDate"])
            if due is None:
                raise ValueError("截止日期无效")
            updates["due_date"] = iso_date(due)
        if "categoryId" in body:
            updates["category_id"] = int(body["categoryId"]) if body["categoryId"] not in (None, "", 0) else None
        if "goalId" in body:
            updates["goal_id"] = int(body["goalId"]) if body["goalId"] not in (None, "", 0) else None
        if "projectId" in body:
            updates["project_id"] = int(body["projectId"]) if body["projectId"] not in (None, "", 0) else None
        if "teamGoalId" in body:
            updates["team_goal_id"] = int(body["teamGoalId"]) if body["teamGoalId"] not in (None, "", 0) else None
        if "content" in body:
            updates["content"] = clean_text(body["content"], 20000)
        if "blocked" in body:
            updates["blocked"] = 1 if body["blocked"] else 0
        if "done" in body:
            updates["done"] = 1 if body["done"] else 0
            updates["completed_at"] = now if body["done"] else None
        if "postpone" in body and body["postpone"]:
            updates["due_date"] = iso_date(date.today() + timedelta(days=1))
            updates["postponed_count"] = int(body.get("postponedCount", 0)) + 1
    elif table == "categories":
        if "name" in body:
            name = clean_text(body["name"], 120)
            if not name:
                raise ValueError("分类名称不能为空")
            updates["name"] = name
        if "description" in body:
            updates["description"] = clean_text(body["description"], 5000)
        if "status" in body:
            updates["status"] = clean_text(body["status"], 30) or "normal"
    elif table == "ideas":
        if "title" in body:
            updates["title"] = clean_text(body["title"], 200)
        if "content" in body:
            content = clean_text(body["content"], 5000)
            if not content:
                raise ValueError("想法内容不能为空")
            updates["content"] = content
        if "tags" in body:
            updates["tags"] = clean_text(body["tags"], 500)
    elif table == "goals":
        if "title" in body:
            title = clean_text(body["title"], 300)
            if not title:
                raise ValueError("目标名称不能为空")
            updates["title"] = title
        if "content" in body:
            updates["content"] = clean_text(body["content"], 20000)
        if "status" in body:
            updates["status"] = clean_text(body["status"], 30) or "in_progress"
        if "dueDate" in body:
            due = to_date(body["dueDate"])
            updates["due_date"] = iso_date(due) if due else None
    elif table == "projects":
        if "name" in body:
            name = clean_text(body["name"], 200)
            if not name:
                raise ValueError("项目名称不能为空")
            updates["name"] = name
        if "description" in body:
            updates["description"] = clean_text(body["description"], 5000)
        if "status" in body:
            updates["status"] = clean_text(body["status"], 30) or "in_progress"
        if "startDate" in body:
            start = to_date(body["startDate"])
            updates["start_date"] = iso_date(start) if start else None
        if "dueDate" in body:
            due = to_date(body["dueDate"])
            updates["due_date"] = iso_date(due) if due else None
    elif table == "team_members":
        if "name" in body:
            name = clean_text(body["name"], 120)
            if not name:
                raise ValueError("成员姓名不能为空")
            updates["name"] = name
        if "role" in body:
            updates["role"] = clean_text(body["role"], 120)
        if "status" in body:
            updates["status"] = clean_text(body["status"], 30) or "normal"
        if "strengths" in body:
            updates["strengths"] = clean_text(body["strengths"], 5000)
        if "risks" in body:
            updates["risks"] = clean_text(body["risks"], 5000)
    elif table == "team_goals":
        if "title" in body:
            title = clean_text(body["title"], 300)
            if not title:
                raise ValueError("目标名称不能为空")
            updates["title"] = title
        if "objectives" in body:
            updates["objectives"] = clean_text(body["objectives"], 5000)
        if "plan" in body:
            updates["plan"] = clean_text(body["plan"], 5000)
        if "status" in body:
            updates["status"] = clean_text(body["status"], 30) or "in_progress"
        if "period" in body:
            updates["period"] = clean_text(body["period"], 30) or "monthly"
        if "dueDate" in body:
            due = to_date(body["dueDate"])
            updates["due_date"] = iso_date(due) if due else None
    elif table == "team_progress":
        if "result" in body:
            updates["result"] = clean_text(body["result"], 5000)
        if "status" in body:
            updates["status"] = clean_text(body["status"], 30) or "in_progress"
        if "blockers" in body:
            updates["blockers"] = clean_text(body["blockers"], 5000)
        if "weekStart" in body:
            week = to_date(body["weekStart"])
            updates["week_start"] = iso_date(week) if week else iso_date(monday_of())
    updates.pop("created_at", None)
    return updates


def clear_examples(user_id: int) -> None:
    with get_database().connect() as connection:
        for table in ("team_progress", "team_goals", "team_members", "ideas", "tasks", "goals", "projects", "categories"):
            connection.execute(f"DELETE FROM {table} WHERE user_id = ?", (user_id,))


def export_backup(connection: sqlite3.Connection, user_id: int) -> dict[str, Any]:
    username = connection.execute("SELECT username FROM users WHERE id=?", (user_id,)).fetchone()
    tables = {}
    for key, table in (("tasks", "tasks"), ("categories", "categories"), ("goals", "goals"),
                       ("projects", "projects"), ("teamMembers", "team_members"), ("ideas", "ideas"),
                       ("teamGoals", "team_goals"), ("teamProgress", "team_progress")):
        rows = connection.execute(f"SELECT * FROM {table} WHERE user_id=? ORDER BY id", (user_id,)).fetchall()
        tables[key] = [dict(row) for row in rows]
    return {"kind": "datu-workbench-backup", "version": 1, "exportedAt": datetime.now().isoformat(timespec="seconds"),
            "username": username["username"] if username else "", **tables}


def import_backup(user_id: int, data: dict[str, Any]) -> dict[str, Any]:
    now = datetime.now().isoformat(timespec="seconds")
    counts: dict[str, int] = {}
    with get_database().connect() as connection:
        for table in ("team_progress", "team_goals", "team_members", "ideas", "tasks", "goals", "projects", "categories"):
            connection.execute(f"DELETE FROM {table} WHERE user_id = ?", (user_id,))
        category_map: dict[int, int] = {}
        for row in data.get("categories", []):
            cursor = connection.execute(
                "INSERT INTO categories(user_id,name,description,status,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                (user_id, clean_text(row.get("name"), 120), clean_text(row.get("description"), 5000),
                 clean_text(row.get("status"), 30) or "normal", now, now),
            )
            old_id = int(row.get("id") or 0)
            if old_id:
                category_map[old_id] = int(cursor.lastrowid)
        counts["categories"] = len(category_map)
        for row in data.get("tasks", []):
            due = to_date(row.get("due_date"))
            if not due:
                continue
            old_category = int(row.get("category_id") or 0)
            connection.execute(
                """
                INSERT INTO tasks(user_id,category_id,title,priority,due_date,blocked,done,postponed_count,
                                  completed_at,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?)
                """,
                (user_id, category_map.get(old_category), clean_text(row.get("title"), 300) or "未命名任务",
                 clean_text(row.get("priority"), 50) or "normal", iso_date(due), int(bool(row.get("blocked"))),
                 int(bool(row.get("done"))), max(0, int(row.get("postponed_count") or 0)), row.get("completed_at"), now, now),
            )
        for row in data.get("ideas", []):
            content = clean_text(row.get("content"), 5000)
            if not content:
                continue
            connection.execute(
                "INSERT INTO ideas(user_id,title,content,tags,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                (user_id, clean_text(row.get("title"), 200) or content[:30], content,
                 clean_text(row.get("tags"), 500), now, now),
            )
        for row in data.get("teamGoals", []):
            title = clean_text(row.get("title"), 300)
            if not title:
                continue
            due = to_date(row.get("due_date"))
            connection.execute(
                "INSERT INTO team_goals(user_id,period,title,objectives,plan,status,due_date,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
                (user_id, clean_text(row.get("period"), 30) or "monthly", title, clean_text(row.get("objectives"), 5000),
                 clean_text(row.get("plan"), 5000), clean_text(row.get("status"), 30) or "in_progress",
                 iso_date(due) if due else None, now, now),
            )
        goal_rows = connection.execute("SELECT id, title FROM team_goals WHERE user_id=? ORDER BY id", (user_id,)).fetchall()
        goal_map = {row["title"]: int(row["id"]) for row in goal_rows}
        for row in data.get("teamProgress", []):
            goal_id = int(row.get("goal_id") or 0)
            if goal_id not in goal_map:
                goal_map_values = list(goal_map.values())
                if not goal_map_values:
                    continue
                goal_id = goal_map_values[int(row.get("goal_id") - 1) % len(goal_map_values)]
            connection.execute(
                """
                INSERT INTO team_progress(user_id,goal_id,week_start,result,status,blockers,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?,?)
                ON CONFLICT(goal_id, week_start) DO UPDATE SET result=excluded.result,status=excluded.status,
                  blockers=excluded.blockers,updated_at=excluded.updated_at
                """,
                (user_id, goal_id, clean_text(row.get("week_start"), 10), clean_text(row.get("result"), 5000),
                 clean_text(row.get("status"), 30) or "in_progress", clean_text(row.get("blockers"), 5000), now, now),
            )
        counts.update({
            "tasks": connection.execute("SELECT COUNT(*) FROM tasks WHERE user_id=?", (user_id,)).fetchone()[0],
            "ideas": connection.execute("SELECT COUNT(*) FROM ideas WHERE user_id=?", (user_id,)).fetchone()[0],
            "teamGoals": connection.execute("SELECT COUNT(*) FROM team_goals WHERE user_id=?", (user_id,)).fetchone()[0],
            "teamProgress": connection.execute("SELECT COUNT(*) FROM team_progress WHERE user_id=?", (user_id,)).fetchone()[0],
        })
    return counts


def run_server(host: str, port: int) -> None:
    database = get_database()
    seed_default_user(database)
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"DATU 工作台已启动: http://{host}:{port}", flush=True)
    print(f"数据库位置: {db_path()}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("服务已停止", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="DATU workbench server")
    parser.add_argument("--host", default=os.environ.get("DATU_HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("DATU_PORT", "8800")))
    arguments = parser.parse_args()
    run_server(arguments.host, arguments.port)
