"""快速验证 Supabase 与 participants 表连通（需 .env 与 schema_video_collector.sql）。"""

import os

from dotenv import load_dotenv
from supabase import create_client

load_dotenv()
url = os.getenv("SUPABASE_URL")
key = os.getenv("SUPABASE_KEY")
if not url or not key:
    raise SystemExit("需要 SUPABASE_URL / SUPABASE_KEY")
supabase = create_client(url, key)
result = supabase.table("participants").select("id").limit(1).execute()
print(result)
