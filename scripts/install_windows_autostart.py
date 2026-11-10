# -*- coding: utf-8 -*-
"""
تثبيت التشغيل المستقل التلقائي في ويندوز (Windows Task Scheduler + Startup)
بحيث يعمل السيرفر ونفق Cloudflare 24/7 بدون الاعتماد على نافذة CMD أو بيئة المحادثة.
"""

import os
import shutil
import subprocess
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
VBS_PATH = BASE_DIR / "scripts" / "launch_hidden.vbs"
STARTUP_DIR = Path(os.environ.get("APPDATA", "")) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"
TASK_NAME = "RAMBFE_AutoServer"


def main():
    print("1. Installing Windows Startup VBS...")
    if STARTUP_DIR.is_dir():
        target_vbs = STARTUP_DIR / "RAMBFE_AutoServer.vbs"
        shutil.copy2(VBS_PATH, target_vbs)
        print(f"   Copied to Startup: {target_vbs}")

    print("2. Registering Windows Scheduled Task (ONLOGON + Watchdog trigger)...")
    cmd_create = [
        "schtasks", "/Create", "/F",
        "/TN", TASK_NAME,
        "/SC", "ONLOGON",
        "/TR", f'wscript.exe "{VBS_PATH}"',
        "/RL", "LIMITED",
    ]
    res = subprocess.run(cmd_create, capture_output=True, text=True)
    print("   schtasks /Create returncode:", res.returncode, res.stdout.strip(), res.stderr.strip())

    # مهمة فحص دورية كل 5 دقائق تضمن استئناف المراقب لو أوقفه أي تحديث ويندوز
    cmd_watchdog = [
        "schtasks", "/Create", "/F",
        "/TN", f"{TASK_NAME}_KeepAlive",
        "/SC", "MINUTE", "/MO", "5",
        "/TR", f'wscript.exe "{VBS_PATH}"',
        "/RL", "LIMITED",
    ]
    res2 = subprocess.run(cmd_watchdog, capture_output=True, text=True)
    print("   schtasks KeepAlive returncode:", res2.returncode, res2.stdout.strip(), res2.stderr.strip())

    print("3. Hardening Windows Power settings (no sleep on AC/DC)...")
    for args in [
        ["powercfg", "/change", "standby-timeout-ac", "0"],
        ["powercfg", "/change", "standby-timeout-dc", "0"],
        ["powercfg", "/change", "hibernate-timeout-ac", "0"],
        ["powercfg", "/change", "hibernate-timeout-dc", "0"],
    ]:
        subprocess.run(args, capture_output=True, text=True)

    print("4. Triggering RAMBFE_AutoServer task now (completely independent of IDE)...")
    run_res = subprocess.run(["schtasks", "/Run", "/TN", TASK_NAME], capture_output=True, text=True)
    print("   schtasks /Run returncode:", run_res.returncode, run_res.stdout.strip(), run_res.stderr.strip())


if __name__ == "__main__":
    main()
