# ============================================================================
# الملف: src/features/voice/xtts-worker.py
# القسم: Features -> Voice (عامل XTTS-v2 الدائم)
# Hint بالعربي: يحمّل نموذج XTTS-v2 مرة واحدة ويبقى يعمل، فيولّد كل جملة عربية في ثوانٍ بدل دقيقتين.
#               البروتوكول: سطر JSON على stdin لكل طلب {"id", "text", "speaker", "out"}،
#               وسطر JSON على stdout لكل رد {"id", "ok", "error"}، وسطر {"ready": true, ...} بعد التحميل.
#               يعمل محلياً بالكامل (النموذج في vendor/xtts-models)، ولا يتصل بالإنترنت بعد التنزيل الأول.
#               رخصة النموذج: Coqui Public Model License (استخدام شخصي غير تجاري) — وافق عليها القائد.
# ============================================================================
import json
import os
import sys
import time

# كل ما يُطبع للتشخيص يذهب إلى stderr؛ stdout مخصص لرسائل البروتوكول فقط
def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()

def main():
    # وضع -I يتجاهل PYTHONIOENCODING، فنضبط UTF-8 صراحة (النص العربي وأسماء الأصوات)
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    os.environ.setdefault("COQUI_TOS_AGREED", "1")
    real_stdout = sys.stdout
    sys.stdout = sys.stderr  # يمنع رسائل المكتبات من إفساد البروتوكول أثناء التحميل
    started = time.time()
    try:
        import torch
        from TTS.api import TTS
        device = "cuda" if torch.cuda.is_available() else "cpu"
        tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to(device)
        speakers = list(tts.speakers or [])
    except Exception as exc:  # noqa: BLE001
        sys.stdout = real_stdout
        send({"ready": False, "error": str(exc)[:500]})
        return 1
    sys.stdout = real_stdout
    send({"ready": True, "device": device, "speakers": speakers, "loadSeconds": round(time.time() - started, 1)})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            speaker = req.get("speaker") or "Suad Qasim"
            if speaker not in speakers:
                raise ValueError("unknown speaker")
            sys.stdout = sys.stderr
            try:
                tts.tts_to_file(text=str(req["text"]), speaker=speaker, language="ar", file_path=str(req["out"]))
            finally:
                sys.stdout = real_stdout
            send({"id": req_id, "ok": True})
        except Exception as exc:  # noqa: BLE001
            sys.stdout = real_stdout
            send({"id": req_id, "ok": False, "error": str(exc)[:300]})
    return 0

if __name__ == "__main__":
    sys.exit(main())
