# Demo media (三尺寸，02-计划的录制产出)

Recorded 2026-08-13 against published `@antlegion/bus` 0.4.1 (`npx @antlegion/bus demo`, the three-act demo).

| file | size / shape | intended use |
|---|---|---|
| `demo.gif` | 1200×675, 3.5MB | README 顶部横版 GIF（<5MB 达标） |
| `demo-hero.mp4` | 1200×675, 1.1MB | 官网 hero 视频（gif→mp4, yuv420p, faststart） |
| `demo-vertical.gif` | 640×1136 | 公众号竖版动图 |
| `stills/demo-v-{3,6,9,12,15}.png` | 640×1136 | 公众号竖版截图组（按秒抽帧） |

Re-record（可重录，vhs 脚本化）:

```bash
mkdir rec && cd rec && npm i @antlegion/bus   # npx resolves locally, no prompt
vhs ../site/media/demo-hero.tape              # → demo-hero.mp4 会失败(vhs/ffmpeg 兼容问题)，改用下行转
ffmpeg -y -i demo.gif -movflags faststart -pix_fmt yuv420p -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" demo-hero.mp4
vhs ../site/media/demo-vertical.tape
for t in 3 6 9 12 15; do ffmpeg -y -ss $t -i demo-vertical.gif -frames:v 1 stills/demo-v-$t.png; done
```
