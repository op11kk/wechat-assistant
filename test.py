from supabase import create_client
import os

url = os.getenv("SUPABASE_URL")
key = os.getenv("SUPABASE_KEY")
supabase = create_client(url, key)

# 尝试查询 sessions 表
result = supabase.table("sessions").select("*").limit(1).execute()
print(result)