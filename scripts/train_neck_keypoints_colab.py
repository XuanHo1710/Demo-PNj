"""
PnJ Demo — Neck-keypoint YOLO-Pose trainer (Google Colab edition).

WHAT THIS DOES
- Trains a CUSTOM keypoint model that finds 9 neck/upper-chest anchors so the
  web demo can drape a necklace on a real neck instead of "dán ảnh".
- It does NOT need you to hand-annotate anything. The VITON-HD / Virtual Try-On
  datasets already ship OpenPose JSON for every person photo. This script reads
  that OpenPose skeleton and DERIVES the 9 neck anchors geometrically, writes
  them in Ultralytics YOLO-Pose label format, trains `yolo11n-pose`, and exports
  an ONNX you can run in the browser with onnxruntime-web.

THE 9 KEYPOINTS (index order is fixed — the browser decoder must match this):
  0 left_neck_anchor      1 right_neck_anchor   2 chin_bottom
  3 sternum_notch         4 left_clavicle       5 right_clavicle
  6 left_shoulder_inner   7 right_shoulder_inner 8 chest_center

==============================================================================
COLAB QUICK START  (CPU-only by default — no GPU, no payment needed)
==============================================================================
1. Upload THIS file to Colab (or to your Drive). Also have your Kaggle API token
   `kaggle.json` ready (Kaggle -> Account -> Create New API Token).
2. In a Colab cell run:

       !python train_neck_keypoints_colab.py

   On the first run it will:
     - pip install ultralytics / kaggle / pillow / pyyaml / tqdm
     - mount Google Drive
     - ask you to upload kaggle.json (if it can't find one)
     - download + unzip the dataset
     - auto-build the YOLO-Pose dataset from OpenPose
     - train, then export ONNX
3. When it finishes it prints the exact output paths. On Colab everything lands
   under:
       /content/drive/MyDrive/Colab Notebooks/neck_keypoints_pnj/
   The two files you care about are:
       neck_keypoints_pnj/model/neck-pose.onnx        <- copy this into the web app
       neck_keypoints_pnj/model/neck-pose.labels.json <- keypoint schema sidecar

==============================================================================
AFTER TRAINING — where to drop the model in the PnJ Demo project
==============================================================================
Copy `neck-pose.onnx` (and the .labels.json) into:
       PnJ Demo/public/models/neck-pose.onnx
Anything in `public/` is served from the web root, so the browser loads it at
`/models/neck-pose.onnx`. (The folder already exists; it's just empty now.)
The script prints this reminder again at the end.

==============================================================================
USEFUL ENV OVERRIDES (optional — set before `!python ...`, e.g. %env EPOCHS=20)
==============================================================================
  DEVICE         "cpu" (default) | "0" for the FREE Colab T4 GPU | "auto".
  FRACTION       Fraction of images to train on (default 0.2). Lower = faster.
  EPOCHS         Training epochs (default 30).
  IMGSZ          Square training size (default 320; 256 faster, 640 sharper).
  BATCH          Batch size (default 8).
  WORKERS        Dataloader workers (default 2).
  CACHE          Cache images in "ram"/"disk" to skip re-reads (default false).
  BASE_MODEL     Starting weights (default yolo11n-pose.pt = the lightest).
  DATASET_SLUG   Kaggle dataset to pull. Default the VITON-HD Zalando set:
                 marquis03/high-resolution-viton-zalando-dataset
                 (alt: adarshsingh0903/virtual-tryon-dataset)
  RAW_DATA_DIR   Skip the Kaggle download and point at an already-extracted folder.
  MAX_SAMPLES    Cap images when BUILDING the dataset (default = all valid).
  VAL_FRACTION   Validation split fraction (default 0.1).
  SKIP_TRAIN=1   Only build the dataset + previews, don't train (sanity check).

CPU IS SLOW: a full CPU run is a few hours. For ~15 min instead, switch to the
free T4 (Runtime -> Change runtime type -> T4 GPU) and set DEVICE=0.
"""

from __future__ import annotations

import json
import math
import os
import random
import shutil
import subprocess
import sys
from pathlib import Path


# =============================================================================
# Config
# =============================================================================

RUNNING_IN_COLAB = Path("/content").exists() and (
    "COLAB_RELEASE_TAG" in os.environ
    or "COLAB_BACKEND_VERSION" in os.environ
    or "COLAB_GPU" in os.environ
)

BASE_DIR = Path(__file__).resolve().parent if "__file__" in globals() else Path.cwd()
DEFAULT_OUTPUT_ROOT = (
    Path("/content/drive/MyDrive/Colab Notebooks")
    if RUNNING_IN_COLAB
    else BASE_DIR / "outputs_new_data"
)

# Everything this script produces goes under one tidy subfolder so it never
# clutters your Drive root.
OUTPUT_ROOT = Path(os.environ.get("OUTPUT_ROOT", str(DEFAULT_OUTPUT_ROOT / "neck_keypoints_pnj")))
DATASET_DIR = OUTPUT_ROOT / "dataset"          # YOLO images/ + labels/ end up here
RAW_DIR = Path(os.environ.get("RAW_DATA_DIR", str(OUTPUT_ROOT / "raw")))  # downloaded dataset
RUNS_DIR = OUTPUT_ROOT / "runs"                # Ultralytics training runs
MODEL_OUT = OUTPUT_ROOT / "model"              # final best.pt + neck-pose.onnx
PREVIEW_DIR = OUTPUT_ROOT / "label_preview"    # sanity-check overlays of auto-labels
DATA_YAML = OUTPUT_ROOT / "neck_keypoints.yaml"

DATASET_SLUG = os.environ.get("DATASET_SLUG", "marquis03/high-resolution-viton-zalando-dataset")
BASE_MODEL = os.environ.get("BASE_MODEL", "yolo11n-pose.pt")

# --- Light, CPU-only defaults -------------------------------------------------
# Training YOLO-pose on CPU is slow, so these keep one run down to a few hours
# instead of days: CPU device, small imgsz, only a FRACTION of the images, fewer
# epochs, and an explicit small batch (Ultralytics auto-batch is GPU-only and
# just warns + falls back to 16 on CPU). The model is yolo11n-pose, already the
# lightest. Tip: Colab's T4 GPU runtime is FREE — Runtime -> Change runtime type
# -> T4 GPU, then set DEVICE=0 for a ~10-20x speedup (no payment needed).
DEVICE = os.environ.get("DEVICE", "cpu").strip()          # "cpu" | "0" (GPU) | "auto"
EPOCHS = int(os.environ.get("EPOCHS", "30"))
IMGSZ = int(os.environ.get("IMGSZ", "320"))               # 320 ~= 4x faster than 640 on CPU
BATCH = int(os.environ.get("BATCH", "8"))                 # explicit (no GPU auto-batch on CPU)
WORKERS = int(os.environ.get("WORKERS", "2"))             # Colab CPUs have few cores
CACHE = os.environ.get("CACHE", "false").strip().lower()  # "ram" | "disk" | "false"
# Train on only a FRACTION of the images each run — the single biggest CPU speed
# lever, and it works on an already-built dataset without rebuilding/redownloading.
FRACTION = float(os.environ.get("FRACTION", "0.2"))       # 0.2 = ~1/5 of the images
PATIENCE = int(os.environ.get("PATIENCE", "10"))
SEED = int(os.environ.get("SEED", "42"))
VAL_FRACTION = float(os.environ.get("VAL_FRACTION", "0.1"))
# Optional hard cap while *building* the dataset (default: convert all valid
# images once). Day-to-day training size is controlled by FRACTION above.
_max_env = os.environ.get("MAX_SAMPLES", "").strip().lower()
MAX_SAMPLES = None if _max_env in ("", "0", "-1", "all", "none") else int(_max_env)
PREVIEW_COUNT = int(os.environ.get("PREVIEW_COUNT", "12"))
SKIP_TRAIN = os.environ.get("SKIP_TRAIN", "0") == "1"
SKIP_DOWNLOAD = os.environ.get("SKIP_DOWNLOAD", "0") == "1" or "RAW_DATA_DIR" in os.environ

# The keypoint contract. KEYPOINT_NAMES order == output channel order == what the
# browser decoder must assume. FLIP_IDX swaps left<->right anchors when Ultralytics
# horizontally flips an image for augmentation (anatomical left becomes right).
KEYPOINT_NAMES = [
    "left_neck_anchor",      # 0
    "right_neck_anchor",     # 1
    "chin_bottom",           # 2
    "sternum_notch",         # 3
    "left_clavicle",         # 4
    "right_clavicle",        # 5
    "left_shoulder_inner",   # 6
    "right_shoulder_inner",  # 7
    "chest_center",          # 8
]
FLIP_IDX = [1, 0, 2, 3, 5, 4, 7, 6, 8]
NUM_KPT = len(KEYPOINT_NAMES)


# =============================================================================
# Environment bootstrap (pip, Drive, Kaggle)
# =============================================================================


def _pip_install(pkgs: list[str]) -> None:
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", *pkgs], check=False)


def ensure_deps() -> None:
    """Install the heavy libs on first run. Cheap no-op once they exist."""
    needed: list[str] = []
    for mod, pkg in (
        ("ultralytics", "ultralytics"),
        ("yaml", "pyyaml"),
        ("PIL", "pillow"),
        ("tqdm", "tqdm"),
    ):
        try:
            __import__(mod)
        except ImportError:
            needed.append(pkg)
    if RUNNING_IN_COLAB:
        try:
            __import__("kaggle")
        except (ImportError, OSError):
            # kaggle imports OSError when ~/.kaggle/kaggle.json is missing; install anyway.
            needed.append("kaggle")
    if needed:
        print(f"[setup] installing: {', '.join(sorted(set(needed)))}")
        _pip_install(sorted(set(needed)))


def mount_drive_if_colab() -> None:
    if not RUNNING_IN_COLAB:
        return
    if Path("/content/drive/MyDrive").exists():
        return
    try:
        from google.colab import drive  # type: ignore

        print("[setup] mounting Google Drive ...")
        drive.mount("/content/drive")
    except Exception as exc:  # pragma: no cover - Colab only
        print(f"[setup] Drive mount skipped ({exc}). Outputs will stay on the Colab VM.")


def setup_kaggle() -> bool:
    """Make sure the Kaggle API can authenticate. Returns False if it can't."""
    kaggle_dir = Path.home() / ".kaggle"
    target = kaggle_dir / "kaggle.json"
    if target.exists():
        os.chmod(target, 0o600)
        return True

    # Common spots people drop the token in Colab.
    for cand in (
        Path("/content/kaggle.json"),
        BASE_DIR / "kaggle.json",
        Path.cwd() / "kaggle.json",
    ):
        if cand.exists():
            kaggle_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy(cand, target)
            os.chmod(target, 0o600)
            return True

    # Env-injected credentials (KAGGLE_USERNAME / KAGGLE_KEY) also work.
    if os.environ.get("KAGGLE_USERNAME") and os.environ.get("KAGGLE_KEY"):
        return True

    if RUNNING_IN_COLAB:
        try:
            from google.colab import files  # type: ignore

            print("[kaggle] Upload your kaggle.json (Kaggle -> Account -> Create New API Token):")
            uploaded = files.upload()
            for name in uploaded:
                if name.endswith(".json"):
                    kaggle_dir.mkdir(parents=True, exist_ok=True)
                    with open(target, "wb") as fh:
                        fh.write(uploaded[name])
                    os.chmod(target, 0o600)
                    return True
        except Exception as exc:  # pragma: no cover - Colab only
            print(f"[kaggle] upload failed: {exc}")

    print(
        "[kaggle] No credentials found. Put kaggle.json in ~/.kaggle/ or set "
        "KAGGLE_USERNAME / KAGGLE_KEY, or set RAW_DATA_DIR to a pre-extracted dataset."
    )
    return False


def download_dataset() -> None:
    if SKIP_DOWNLOAD:
        print(f"[data] SKIP_DOWNLOAD set — using existing folder: {RAW_DIR}")
        return
    if RAW_DIR.exists() and any(RAW_DIR.rglob("*_keypoints.json")):
        print(f"[data] dataset already present at {RAW_DIR} — skipping download.")
        return
    if not setup_kaggle():
        raise SystemExit("[data] cannot download without Kaggle credentials. See message above.")

    RAW_DIR.mkdir(parents=True, exist_ok=True)
    print(f"[data] downloading {DATASET_SLUG} -> {RAW_DIR} (this can take a while) ...")
    subprocess.run(
        [sys.executable, "-m", "kaggle", "datasets", "download", "-d", DATASET_SLUG,
         "-p", str(RAW_DIR), "--unzip"],
        check=True,
    )
    print("[data] download + unzip done.")


# =============================================================================
# OpenPose -> 9 neck keypoints
# =============================================================================


def _named_points(flat: list[float]) -> dict | None:
    """Map a flat OpenPose keypoint list to named (x, y, conf) tuples.

    Handles the three layouts these datasets use: COCO-17, OpenPose COCO-18 and
    BODY_25. Indices 0..7 (nose..left wrist) are identical across COCO-18/BODY_25.
    """
    n = len(flat) // 3
    if n < 1:
        return None

    def P(i):
        if i is None or i * 3 + 2 >= len(flat):
            return None
        x, y, c = flat[i * 3], flat[i * 3 + 1], flat[i * 3 + 2]
        if c <= 0 and x == 0 and y == 0:
            return None
        return (float(x), float(y), float(c))

    if n >= 25:  # BODY_25
        idx = dict(nose=0, neck=1, rsho=2, lsho=5, midhip=8, rhip=9, lhip=12,
                   reye=15, leye=16, rear=17, lear=18)
    elif n >= 18:  # OpenPose COCO-18 (has an explicit neck at index 1)
        idx = dict(nose=0, neck=1, rsho=2, lsho=5, midhip=None, rhip=8, lhip=11,
                   reye=14, leye=15, rear=16, lear=17)
    else:  # COCO-17 (no neck joint — synthesize it later from the shoulders)
        idx = dict(nose=0, neck=None, lsho=5, rsho=6, midhip=None, lhip=11, rhip=12,
                   reye=2, leye=1, rear=4, lear=3)

    return {k: (P(v) if v is not None else None) for k, v in idx.items()}


def _lerp(a, b, t):
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


def _vof(c: float) -> int:
    """OpenPose confidence -> YOLO visibility flag (2 visible, 1 occluded, 0 missing)."""
    if c > 0.10:
        return 2
    if c > 0.0:
        return 1
    return 0


def derive_neck_keypoints(named: dict, W: int, H: int):
    """Return [(x, y, v), ... 9 ...] in pixel coords, or None if too little data."""
    nose = named.get("nose")
    neck = named.get("neck")
    lsho = named.get("lsho")
    rsho = named.get("rsho")

    # Synthesize neck from shoulders when the layout has no neck joint (COCO-17).
    if neck is None and lsho and rsho:
        neck = ((lsho[0] + rsho[0]) / 2, (lsho[1] + rsho[1]) / 2, min(lsho[2], rsho[2]))
    if neck is None or (lsho is None and rsho is None):
        return None  # need a neck and at least one shoulder to be meaningful

    # Mirror a missing shoulder across the neck so single-visible-shoulder shots still work.
    if lsho is None and rsho is not None:
        lsho = (2 * neck[0] - rsho[0], rsho[1], rsho[2] * 0.5)
    if rsho is None and lsho is not None:
        rsho = (2 * neck[0] - lsho[0], lsho[1], lsho[2] * 0.5)

    midhip = named.get("midhip")
    if midhip is None:
        lhip, rhip = named.get("lhip"), named.get("rhip")
        if lhip and rhip:
            midhip = ((lhip[0] + rhip[0]) / 2, (lhip[1] + rhip[1]) / 2, min(lhip[2], rhip[2]))

    shoulder_w = math.hypot(lsho[0] - rsho[0], lsho[1] - rsho[1]) or (0.25 * W)

    # head-down direction (nose -> neck); falls back to straight down
    if nose:
        dn = (neck[0] - nose[0], neck[1] - nose[1])
        dnl = math.hypot(*dn) or 1.0
        down = (dn[0] / dnl, dn[1] / dnl)
    else:
        dnl, down = 0.5 * shoulder_w, (0.0, 1.0)

    # torso-down direction (neck -> mid-hip); falls back along head-down
    if midhip:
        tv = (midhip[0] - neck[0], midhip[1] - neck[1])
    else:
        tv = (down[0] * shoulder_w * 1.6, down[1] * shoulder_w * 1.6)
        midhip = (neck[0] + tv[0], neck[1] + tv[1], 0.3)
    tvl = math.hypot(*tv) or 1.0
    tdown = (tv[0] / tvl, tv[1] / tvl)

    # person's-left horizontal unit (right shoulder -> left shoulder)
    su = (lsho[0] - rsho[0], lsho[1] - rsho[1])
    sul = math.hypot(*su) or 1.0
    sdir = (su[0] / sul, su[1] / sul)

    # chin: ~halfway from nose down to the neck
    if nose:
        chin = (nose[0] + down[0] * dnl * 0.5, nose[1] + down[1] * dnl * 0.5)
        chin_c = min(nose[2], neck[2])
    else:
        chin = (neck[0] - tdown[0] * shoulder_w * 0.5, neck[1] - tdown[1] * shoulder_w * 0.5)
        chin_c = neck[2] * 0.6

    neck_half = 0.17 * shoulder_w
    mid_up = _lerp(neck, chin, 0.55)  # a point up the neck column, between base and chin
    left_neck = (mid_up[0] + sdir[0] * neck_half, mid_up[1] + sdir[1] * neck_half)
    right_neck = (mid_up[0] - sdir[0] * neck_half, mid_up[1] - sdir[1] * neck_half)
    sternum = (neck[0] + tdown[0] * 0.10 * shoulder_w, neck[1] + tdown[1] * 0.10 * shoulder_w)
    l_clav = _lerp(neck, lsho, 0.45)
    r_clav = _lerp(neck, rsho, 0.45)
    l_sin = _lerp(neck, lsho, 0.72)
    r_sin = _lerp(neck, rsho, 0.72)
    chest = (neck[0] + tdown[0] * 0.28 * tvl, neck[1] + tdown[1] * 0.28 * tvl)

    nc, lc, rc = neck[2], lsho[2], rsho[2]
    mc = midhip[2] if midhip else nc
    raw = [
        (left_neck, _vof(min(nc, lc))),
        (right_neck, _vof(min(nc, rc))),
        (chin, _vof(chin_c)),
        (sternum, _vof(nc)),
        (l_clav, _vof(min(nc, lc))),
        (r_clav, _vof(min(nc, rc))),
        (l_sin, _vof(lc)),
        (r_sin, _vof(rc)),
        (chest, _vof(min(nc, mc))),
    ]
    # clamp into the frame; keep the visibility flag (edge points are still useful signal)
    pts = []
    for (x, y), v in raw:
        pts.append((min(max(x, 0.0), W - 1.0), min(max(y, 0.0), H - 1.0), v))
    return pts


def _bbox_from_points(pts, W, H, pad_px):
    xs = [p[0] for p in pts if p[2] > 0] or [p[0] for p in pts]
    ys = [p[1] for p in pts if p[2] > 0] or [p[1] for p in pts]
    x0, x1 = min(xs) - pad_px, max(xs) + pad_px
    y0, y1 = min(ys) - pad_px, max(ys) + pad_px
    x0, y0 = max(x0, 0.0), max(y0, 0.0)
    x1, y1 = min(x1, W - 1.0), min(y1, H - 1.0)
    cx, cy = (x0 + x1) / 2 / W, (y0 + y1) / 2 / H
    bw, bh = max(x1 - x0, 1.0) / W, max(y1 - y0, 1.0) / H
    return cx, cy, bw, bh


# =============================================================================
# Build the YOLO-Pose dataset
# =============================================================================


def _index_images(root: Path) -> dict:
    """Map every image stem -> path (so we can pair an OpenPose json to its photo)."""
    exts = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
    by_stem: dict[str, Path] = {}
    for p in root.rglob("*"):
        if p.suffix.lower() in exts:
            by_stem.setdefault(p.stem, p)
    return by_stem


def _match_image(json_path: Path, by_stem: dict) -> Path | None:
    stem = json_path.name
    for suffix in ("_keypoints.json", ".json"):
        if stem.endswith(suffix):
            stem = stem[: -len(suffix)]
            break
    if stem in by_stem:
        return by_stem[stem]
    # Some sets name the json after the cloth/parse variant; try trimming a trailing _N.
    if "_" in stem and stem.rsplit("_", 1)[0] in by_stem:
        return by_stem[stem.rsplit("_", 1)[0]]
    return None


def build_dataset() -> int:
    from PIL import Image  # noqa: WPS433 (lazy import after ensure_deps)
    from tqdm import tqdm  # noqa: WPS433

    for sub in ("images/train", "images/val", "labels/train", "labels/val"):
        (DATASET_DIR / sub).mkdir(parents=True, exist_ok=True)
    PREVIEW_DIR.mkdir(parents=True, exist_ok=True)

    json_files = sorted(RAW_DIR.rglob("*_keypoints.json"))
    if not json_files:
        # Fallback: any json that parses as OpenPose.
        json_files = sorted(RAW_DIR.rglob("*.json"))
    if not json_files:
        raise SystemExit(f"[build] no OpenPose json found under {RAW_DIR}.")

    print(f"[build] indexing images under {RAW_DIR} ...")
    by_stem = _index_images(RAW_DIR)
    print(f"[build] found {len(by_stem)} images, {len(json_files)} pose json files.")

    random.seed(SEED)
    random.shuffle(json_files)

    kept = 0
    previews = 0
    for jp in tqdm(json_files, desc="[build] converting"):
        if MAX_SAMPLES and kept >= MAX_SAMPLES:
            break
        try:
            data = json.loads(jp.read_text(encoding="utf-8", errors="ignore"))
        except (json.JSONDecodeError, OSError):
            continue
        people = data.get("people") or []
        if not people:
            continue
        flat = people[0].get("pose_keypoints_2d") or []
        named = _named_points(flat)
        if not named:
            continue

        img_path = _match_image(jp, by_stem)
        if img_path is None:
            continue
        try:
            with Image.open(img_path) as im:
                W, H = im.size
        except Exception:
            continue

        pts = derive_neck_keypoints(named, W, H)
        if pts is None:
            continue
        if sum(1 for p in pts if p[2] > 0) < 4:
            continue  # too few reliable anchors to learn from

        cx, cy, bw, bh = _bbox_from_points(pts, W, H, pad_px=0.06 * W)

        split = "val" if random.random() < VAL_FRACTION else "train"
        stem = img_path.stem
        out_img = DATASET_DIR / "images" / split / f"{stem}{img_path.suffix.lower()}"
        out_lbl = DATASET_DIR / "labels" / split / f"{stem}.txt"
        if not out_img.exists():
            shutil.copy(img_path, out_img)

        row = [f"0 {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}"]
        for (x, y, v) in pts:
            if v == 0:
                row.append("0 0 0")
            else:
                row.append(f"{x / W:.6f} {y / H:.6f} {v}")
        out_lbl.write_text(" ".join(row) + "\n", encoding="utf-8")
        kept += 1

        if previews < PREVIEW_COUNT:
            _save_preview(img_path, pts, previews)
            previews += 1

    print(f"[build] wrote {kept} labelled images "
          f"(previews in {PREVIEW_DIR}).")
    if kept == 0:
        raise SystemExit("[build] 0 usable samples — check the dataset layout / DATASET_SLUG.")
    return kept


def _save_preview(img_path: Path, pts, n: int) -> None:
    """Draw the derived anchors on a few images so you can eyeball the auto-labels."""
    try:
        import cv2  # noqa: WPS433
    except ImportError:
        return
    img = cv2.imread(str(img_path))
    if img is None:
        return
    for i, (x, y, v) in enumerate(pts):
        if v == 0:
            continue
        color = (0, 255, 0) if v == 2 else (0, 165, 255)
        cv2.circle(img, (int(x), int(y)), 5, color, -1)
        cv2.putText(img, str(i), (int(x) + 6, int(y) - 6),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
    cv2.imwrite(str(PREVIEW_DIR / f"preview_{n:02d}.jpg"), img)


def write_data_yaml() -> Path:
    import yaml  # noqa: WPS433

    cfg = {
        "path": str(DATASET_DIR),
        "train": "images/train",
        "val": "images/val",
        "kpt_shape": [NUM_KPT, 3],
        "flip_idx": FLIP_IDX,
        "names": {0: "neck"},
    }
    DATA_YAML.write_text(yaml.safe_dump(cfg, sort_keys=False), encoding="utf-8")
    print(f"[build] dataset config -> {DATA_YAML}")
    return DATA_YAML


# =============================================================================
# Train + export
# =============================================================================


def _resolve_device():
    """Pick the training device. Default 'cpu' (user is CPU-only). DEVICE='auto'
    uses a GPU if one is present; DEVICE='0' forces the first GPU (free Colab T4)."""
    want = DEVICE.lower()
    if want in ("", "cpu"):
        return "cpu"
    if want == "auto":
        try:
            import torch  # noqa: WPS433

            if torch.cuda.is_available():
                return 0
        except ImportError:
            pass
        return "cpu"
    try:
        return int(want)
    except ValueError:
        return want


def _cache_arg():
    """Translate the CACHE env into the value Ultralytics expects."""
    if CACHE in ("ram", "disk"):
        return CACHE
    return CACHE in ("1", "true", "yes")


def train_and_export() -> None:
    from ultralytics import YOLO  # noqa: WPS433

    MODEL_OUT.mkdir(parents=True, exist_ok=True)
    dev = _resolve_device()
    print(f"[train] base={BASE_MODEL} epochs={EPOCHS} imgsz={IMGSZ} batch={BATCH} "
          f"fraction={FRACTION} device={dev}")

    model = YOLO(BASE_MODEL)
    model.train(
        data=str(DATA_YAML),
        epochs=EPOCHS,
        imgsz=IMGSZ,
        batch=BATCH,
        device=dev,
        workers=WORKERS,
        cache=_cache_arg(),
        fraction=FRACTION,
        patience=PATIENCE,
        seed=SEED,
        project=str(RUNS_DIR),
        name="neck_pose",
        exist_ok=True,
        pretrained=True,
    )

    best = RUNS_DIR / "neck_pose" / "weights" / "best.pt"
    if not best.exists():
        raise SystemExit(f"[train] expected weights not found at {best}")
    shutil.copy(best, MODEL_OUT / "neck-pose.pt")

    print("[export] exporting ONNX (opset 12, static shapes for onnxruntime-web) ...")
    exporter = YOLO(str(best))
    onnx_path = exporter.export(format="onnx", imgsz=IMGSZ, opset=12, simplify=True, dynamic=False)
    final_onnx = MODEL_OUT / "neck-pose.onnx"
    shutil.copy(str(onnx_path), final_onnx)

    # Sidecar so the browser decoder knows the channel order + flip map.
    (MODEL_OUT / "neck-pose.labels.json").write_text(
        json.dumps(
            {
                "task": "pose",
                "imgsz": IMGSZ,
                "num_keypoints": NUM_KPT,
                "kpt_shape": [NUM_KPT, 3],
                "keypoint_names": KEYPOINT_NAMES,
                "flip_idx": FLIP_IDX,
                "output_note": "YOLO11-pose output [1, 4+1+NUM_KPT*3, A]: "
                               "cx,cy,w,h,obj, then (x,y,score) per keypoint.",
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"[export] ONNX -> {final_onnx}")


# =============================================================================
# Main
# =============================================================================


def _final_instructions() -> None:
    onnx = MODEL_OUT / "neck-pose.onnx"
    print("\n" + "=" * 74)
    print("DONE. Outputs:")
    print(f"  ONNX model   : {onnx}")
    print(f"  Torch weights: {MODEL_OUT / 'neck-pose.pt'}")
    print(f"  Label schema : {MODEL_OUT / 'neck-pose.labels.json'}")
    print(f"  Auto-label previews (verify these look right!): {PREVIEW_DIR}")
    print("-" * 74)
    print("PUT THE MODEL IN THE WEB APP:")
    print("  Copy neck-pose.onnx (and neck-pose.labels.json) into:")
    print("      PnJ Demo/public/models/neck-pose.onnx")
    print("  It is then served to the browser at:  /models/neck-pose.onnx")
    print("=" * 74)


def main() -> None:
    ensure_deps()
    mount_drive_if_colab()
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)

    download_dataset()
    build_dataset()
    write_data_yaml()

    if SKIP_TRAIN:
        print("[main] SKIP_TRAIN=1 — dataset + previews built, stopping before training.")
        print(f"[main] inspect: {PREVIEW_DIR}")
        return

    train_and_export()
    _final_instructions()


if __name__ == "__main__":
    main()
