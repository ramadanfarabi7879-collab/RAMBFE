#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
أداة رفع وتحديث المشروع على GitHub بأمان وبدون أي مشاكل في الترميز
Uploads and pushes the project to GitHub with full UTF-8 and git path resolution.
"""

import os
import sys
import shutil
import subprocess
from pathlib import Path

# ضبط مخرجات ومداخل الطرفية للعربية
try:
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    if hasattr(sys.stderr, 'reconfigure'):
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    if hasattr(sys.stdin, 'reconfigure'):
        sys.stdin.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

BASE_DIR = Path(__file__).resolve().parent.parent
os.chdir(BASE_DIR)

def find_git_binary() -> str:
    # 1. فحص PATH
    git_which = shutil.which("git")
    if git_which:
        return git_which

    # 2. فحص مسار MinGit المحلي
    local_app_data = os.environ.get("LOCALAPPDATA", "")
    candidates = [
        Path(local_app_data) / "Programs" / "MinGit" / "cmd" / "git.exe",
        Path(local_app_data) / "Programs" / "Git" / "cmd" / "git.exe",
        Path("C:/Program Files/Git/cmd/git.exe"),
        Path("C:/Program Files (x86)/Git/cmd/git.exe"),
    ]
    for c in candidates:
        if c.is_file():
            # إضافة المسار لـ PATH في الجلسة الحالية
            cmd_dir = str(c.parent)
            os.environ["PATH"] = cmd_dir + os.pathsep + os.environ.get("PATH", "")
            return str(c)

    return "git"

def run_cmd(git_bin, args, capture=False):
    cmd = [git_bin] + args
    if capture:
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8', errors='replace')
        return p.returncode, p.stdout.strip(), p.stderr.strip()
    else:
        p = subprocess.run(cmd)
        return p.returncode

def main():
    print("=" * 65)
    print("      🚀 أداة رفع وتحديث المشروع على GitHub 📦")
    print("=" * 65)
    print()

    git_bin = find_git_binary()

    # 1. التحقق من git
    code, out, _ = run_cmd(git_bin, ["--version"], capture=True)
    if code != 0:
        print("❌ لم يتم العثور على Git في النظام!")
        input("\nاضغط Enter للإغلاق...")
        return 1

    print(f"[*] تم العثور على Git: {out}")

    # 2. فحص مستودع git
    if not (BASE_DIR / ".git").is_dir():
        print("[*] جاري تهيئة مستودع Git محلي...")
        run_cmd(git_bin, ["init"])
        run_cmd(git_bin, ["branch", "-M", "main"])

    # 3. فحص الـ Remote
    code, remotes, _ = run_cmd(git_bin, ["remote", "-v"], capture=True)
    if code != 0 or not remotes or "origin" not in remotes:
        print("\n" + "!" * 65)
        print(" [!] لم يتم ربط مستودع GitHub حتى الآن.")
        print(" 1. أنشئ مستودعاً جديداً على GitHub من خلال الرابط: https://github.com/new")
        print(" 2. انسخ رابط المستودع (مثال: https://github.com/username/invoice-matcher-app.git)")
        print("!" * 65 + "\n")

        repo_url = input("🔗 أدخل رابط مستودع GitHub هنا: ").strip()
        if not repo_url:
            print("❌ لم يتم إدخال أي رابط. تم إلغاء العملية.")
            input("\nاضغط Enter للإغلاق...")
            return 1

        print(f"[*] جاري ربط المستودع: {repo_url}")
        run_cmd(git_bin, ["remote", "remove", "origin"], capture=True)
        rc, _, err = run_cmd(git_bin, ["remote", "add", "origin", repo_url], capture=True)
        if rc != 0:
            print(f"❌ خطأ أثناء إضافة المستودع: {err}")
            input("\nاضغط Enter للإغلاق...")
            return 1
    else:
        print(f"[*] مستودع GitHub المرتبط حالياً:\n{remotes}\n")

    # 4. إضافة الملفات وعمل commit
    print("[*] جاري تجهيز الملفات (git add .)...")
    run_cmd(git_bin, ["add", "."])

    if len(sys.argv) > 1 and sys.argv[1].strip():
        commit_msg = sys.argv[1].strip()
        interactive = False
    else:
        commit_msg = input("\n📝 أدخل رسالة التحديث (أو اضغط Enter للاعتماد الافتراضي): ").strip()
        interactive = True

    if not commit_msg:
        commit_msg = "update: Latest project improvements and mobile sync updates"

    run_cmd(git_bin, ["commit", "-m", commit_msg])
    run_cmd(git_bin, ["branch", "-M", "main"])

    # 5. الرفع إلى GitHub
    print("\n" + "=" * 65)
    print(" ⬆️ جاري الرفع إلى GitHub (git push -u origin main)...")
    print("=" * 65 + "\n")

    push_code = run_cmd(git_bin, ["push", "-u", "origin", "main"])

    if push_code == 0:
        print("\n" + "★" * 65)
        print(" 🎉 تم رفع وتحديث المشروع على GitHub بنجاح تام! ✅")
        print("★" * 65)
    else:
        print("\n" + "!" * 65)
        print(" ⚠️ ملاحظة بخصوص تسجيل الدخول في GitHub:")
        print(" إذا ظهر لك طلب لتسجيل الدخول، يمكنك استخدام:")
        print(" 1. خيار Sign in with your browser (المتصفح) إذا ظهر.")
        print(" 2. أو اسم المستخدم الخاص بك و Personal Access Token (PAT) ككلمة مرور.")
        print("!" * 65)

    if interactive:
        print()
        input("اضغط Enter للإغلاق...")
    return 0

if __name__ == '__main__':
    sys.exit(main())
