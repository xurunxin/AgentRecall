# 发布流程

> 本文档是 `docs/guides/release-publication.md` 的中文版本。**当前实现版本：v1.1.4**。

## 产出候选证据

1. 对精确的候选 SHA 跑 release-candidate workflow。
2. 每个 matrix leg 记录：正式平台 token、实际 Vitest JSON 汇总、job 元数据、产物哈希。
3. `record-evidence` job 用 `scripts/release-evidence.mjs` 合并**正好三份**片段。
4. 跑 `node scripts/verify-release-evidence.mjs --stable --evidence release-evidence.json`。

校验 SHA 时，证据与所有被引用的产物文件必须保持在同一目录。

## 准备发布

把三份归档、哈希清单、暂存文档、以及已校验的 `release-evidence.json` 都放进 `ARTIFACT_DIR`。将 `GITHUB_SHA` 设为已 checkout 的候选，然后跑：

```sh
DRY_RUN=1 ARTIFACT_DIR=/path/to/artifacts GITHUB_SHA=<40-hex-sha> node scripts/prepare-release.mjs
```

审阅生成的发布说明，确认无误后用 `DRY_RUN=0` 重跑。当证据缺失、稳定校验器拒绝、任一记录的 SHA 不一致、或记录的 tag-only workflow 未成功时，准备动作会在创建 tag 之前失败。

## 发布 Tag

Release workflow 仅在 tag 上触发。它从成功的候选 workflow 下载证据，再跑一次稳定校验器，并要求 `release_commit` 与 `candidate_sha` 都等于该 tag 的 `head_sha`。任一不匹配都会阻塞打包。

## 开发诊断

`--dev` 允许 `local://` URL 与 `totals_from: "constant"`，便于本地 fixture 工作。它仍然要求正式平台、完整的产物覆盖、合法的 Schema 与字节一致。开发证据**不可**被准备或发布动作使用。

校验器失败时把 JSON 输出到 stderr。脚本化场景使用 `code` 字段；`detail` 字段仅供说明，可能演进。
