# Terrain-RGB タイル生成パイプライン解説

> **対象**: `scripts/generate_terrain_rgb.py` の設計・判断・バグ回避の経緯を知りたい方  
> Terrarium エンコードの数学から GDAL の落とし穴まで記録します。

---

## 1. Terrarium エンコードとは

MapLibre GL JS の 3D 地形機能 (`setTerrain`) が要求するタイル形式です。  
通常の PNG の RGB 3チャンネルに標高値を格納します。

### 数式

```
elevation = R × 256 + G + B / 256 − 32768  (メートル)
```

逆算（標高 → RGB）:

```
value = elevation + 32768          (0 〜 65535 の範囲に収める)
R = (value >> 8)  & 0xFF           (上位 8 ビット)
G =  value        & 0xFF           (下位 8 ビット)
B = 0                              (JAXA Int16 データでは常に 0)
```

### 代表的な値

| 標高 (m) | value | R | G | B |
|---------|-------|---|---|---|
| −32768 (表現できる最小値) | 0 | 0 | 0 | 0 |
| 0 (海面) | 32768 | 128 | 0 | 0 |
| 100 | 32868 | 128 | 100 | 0 |
| 3776 (富士山) | 36544 | 142 | 192 | 0 |
| 32767 (表現できる最大値) | 65535 | 255 | 255 | 0 |

**海面の Terrarium 値は R=128, G=0, B=0** です。  
R=0, G=0, B=0 は elevation = −32768 m（海溝相当）になるので要注意。

### B チャンネルについて

JAXA AW3D30 は整数 (Int16) の標高データです。小数点以下はないので B は常に 0 です。  
Terrarium は本来 1/256m 単位の精度を B チャンネルに持てますが、整数データでは不要です。

---

## 2. 4 ステップパイプライン

```
JAXA AW3D30 GeoTIFF (390 ファイル × 1°×1°, EPSG:4326)
  │
  │ [1/4] gdalbuildvrt
  ▼
merged_dsm.vrt / merged_msk.vrt   (仮想モザイク — データコピーなし)
  │
  │ [2/4] gdal_calc.py  (ocean masking)
  ▼
masked_dsm.tif   (MSK bit 0x03 の海洋ピクセル → nodata -9999)
  │
  │ [3/4] gdal_calc.py × 4  (Terrarium encoding)
  ▼
value.tif (UInt16)
r_band.tif / g_band.tif / b_band.tif (Byte)
terrain_rgb.vrt (RGB VRT)
  │
  │ [4/4] gdal2tiles.py --xyz --resampling=near
  ▼
web/terrain-rgb/{z}/{x}/{y}.png
```

---

## 3. ステップ詳細

### ステップ 1: VRT モザイク

```bash
gdalbuildvrt -resolution highest -srcnodata -9999 -vrtnodata -9999 \
             -input_file_list dsm_list.txt merged_dsm.vrt
```

VRT (Virtual Dataset) は「複数の GeoTIFF を 1 枚に見せる仮想ファイル」です。  
実データのコピーは発生せず、後続の GDAL コマンドが参照するときに初めて読み込まれます。

`-srcnodata -9999` は入力 nodata 値。`-vrtnodata -9999` は出力 VRT の nodata 宣言。

---

### ステップ 2: 海洋マスキング

```python
gdal_calc.py -D merged_dsm.vrt -M merged_msk.vrt \
    --type=Int16 --NoDataValue=-9999 \
    --calc 'numpy.where((M.astype(numpy.int32) & 3) == 3, numpy.int16(-9999), D)'
```

JAXA AW3D30 の MSK ファイルはビットフラグです。下位 2 ビット (`& 3`) が `0x03` の場合が「海洋」です。  
海洋ピクセルを nodata (-9999) に置換してから Terrarium 変換することで、海面が正しく 0m として扱われます。

---

### ステップ 3: Terrarium エンコード

#### value.tif の生成 (Int16 → UInt16)

```python
gdal_calc.py -A masked_dsm.tif \
    --type=UInt16 --NoDataValue=0 \
    --hideNoData \
    --calc 'numpy.where(A <= -9998,
                        numpy.uint16(32768),
                        numpy.clip(A.astype(numpy.int32) + 32768, 0, 65535).astype(numpy.uint16))'
```

- `A <= -9998`: nodata (-9999) および -9998 以下のピクセルを海面 (32768) に変換
- それ以外: `elevation + 32768` を UInt16 に変換

#### R/G/B バンドの分離

```python
# R バンド: value の上位 8 ビット
(V >> 8).astype(numpy.uint8)

# G バンド: value の下位 8 ビット
(V & 255).astype(numpy.uint8)

# B バンド: 常に 0
numpy.zeros_like(V, dtype=numpy.uint8)
```

---

### ステップ 4: タイル生成

```bash
gdal2tiles.py --xyz --zoom=5-12 --processes=16 \
    --resampling=near --webviewer=none --resume \
    terrain_rgb.vrt web/terrain-rgb/
```

`gdal2tiles.py` は入力が EPSG:4326 (WGS84) でも内部で EPSG:3857 (Web Mercator) に自動変換します。  
`--resume` で既存タイルをスキップするため、ズームレベルを追加生成する際も安全に実行できます。

---

## 4. 重要なバグ回避: `--hideNoData`

### 問題 (GDAL 3.3 以降)

GDAL 3.3 から `gdal_calc.py` の内部で numpy のマスク配列 (`numpy.ma`) が使われるようになりました。  
nodata として宣言されたピクセルは numpy 計算から**暗黙にスキップ**されます。

masked_dsm.tif では海洋ピクセルが nodata (-9999) です。これらは `numpy.where(...)` の計算対象外になり、`--NoDataValue=0` として宣言した **出力 nodata 値 (=0) がそのまま書き込まれます**。

結果:
- 海洋ピクセルの value.tif の値 = `0`
- `R = (0 >> 8) = 0`, `G = (0 & 255) = 0`
- Terrarium 標高: `0 × 256 + 0 + 0/256 − 32768 = **−32768 m**`

海面が −32768 m という謎の海溝になります。

### 修正: `--hideNoData`

```bash
gdal_calc.py -A masked_dsm.tif \
    --hideNoData \      # ← これを付ける
    --NoDataValue=0 \
    --calc '...'
```

`--hideNoData` はすべてのピクセル（nodata を含む）を numpy の通常配列として扱います。  
nodata のマスクが取り除かれるため、`numpy.where` が正しく全ピクセルに適用されます。

### 影響を受けるバンド

value.tif の生成だけでなく、そこから R/G/B を計算する際も同じ問題が起きます。  
全ての `gdal_calc.py` 呼び出しに `--hideNoData` を付けています。

```python
# value.tif 生成
run(['gdal_calc.py', '-A', masked_dsm, '--hideNoData', ...])

# R/G/B バンド生成
run(['gdal_calc.py', '-V', value_tif, '--hideNoData', ...])
```

---

## 5. なぜ gdalwarp を使わないか

旧実装では EPSG:4326 → EPSG:3857 の変換に `gdalwarp` を使っていました。  
これが 2 つ目の問題の原因でした。

### gdalwarp の fill-value 問題

`gdalwarp` はソースデータの範囲外のピクセル（日本の範囲外）を**デフォルトで `0` で埋めます**。

RGB タイルの `(R=0, G=0, B=0)` は Terrarium では elevation = **−32768 m** です。  
日本の周辺海域がすべて −32768 m の海溝になります。

```bash
# 問題のある旧コード
gdalwarp -t_srs EPSG:3857 rgb_vrt.vrt rgb_3857.tif   # → 範囲外が R=0,G=0,B=0
gdal2tiles.py rgb_3857.tif ...
```

### 現在の解決策

`gdal2tiles.py` は入力データの座標系を内部で処理できます。  
EPSG:4326 の VRT をそのまま渡せば、`gdalwarp` は不要です。

```bash
# 現在の実装
gdal2tiles.py terrain_rgb.vrt ...   # EPSG:4326 VRT を直接渡す
```

---

## 6. なぜリサンプリングに `--resampling=near` を使うか

```bash
gdal2tiles.py --resampling=near ...
```

Terrarium は RGB の各バイト値に特定の意味を持たせています。  
`bilinear` や `average` でリサンプリングすると、隣接ピクセルの R/G 値が混ざってしまいます。

```
例: 標高 256m (R=129, G=0) と 512m (R=130, G=0) の bilinear 平均
  R = 129.5 → 切り捨てで 129 → elevation = 129*256 + 0 - 32768 = 320m  ✗
  correct average: (256 + 512) / 2 = 384m                               ✓
```

バイト値を直接補間すると標高値が完全に破壊されます。  
`near`（最近傍）リサンプリングのみが Terrarium エンコーディングを正しく保持します。

---

## 7. 検証方法

生成したタイルの標高値を確認するには:

```bash
# タイル zoom 10 の具体的なファイルを確認
python3 - << 'EOF'
from PIL import Image
import sys

img = Image.open("web/terrain-rgb/10/918/405.png")
r, g, b, *_ = img.getpixel((128, 128))  # タイルの中心ピクセル
elev = r * 256 + g + b / 256 - 32768
print(f"R={r}, G={g}, B={b} → elevation={elev:.3f} m")
# 海洋タイルなら R=128, G=0, B=0 → elevation=0.000 m
EOF
```

海洋タイルで `R=0` が返る場合は `--hideNoData` が欠けているか、`gdalwarp` 経由でタイルを生成しています。

---

## 8. 生成時間の目安 (16 コア, 390 ファイル)

| ステップ | 時間 |
|---------|------|
| VRT 構築 (1) | < 1 秒 |
| 海洋マスク (2) | ~9 分 |
| Terrarium 変換 (3) | ~8 分 |
| タイル生成 zoom 5-12 (4) | ~3 分 |
| **合計** | **~20 分** |

zoom 12 のみ追加する場合（`--resume` で既存をスキップ）は最終ステップが数分です。
