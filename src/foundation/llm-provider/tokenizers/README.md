# V4.1 tokenizer

[`tokenizer.json`](tokenizer.json) is a modified copy of the Hugging Face file
[`deepseek-ai/DeepSeek-V4-Flash-Vision-Exp/tokenizer.json`][upstream] with the image
token reassigned.

## Local changes

| id | this file | upstream |
| --- | --- | --- |
| 129264 | `<｜image｜>` special=true | `<｜deepseek_image｜>` special=false |

All other JSON entries match the comparison revision below.

## Provenance and license

- Comparison revision: `6821d6ad3681a4b137b066b76094fa82ebd0a380`, verified on 2026-09-10.
- Local SHA-256: `81f64d1248a68ce3663e07ab3ee48b851e5df0e32d27cb98e4c9a268151e8d99`.
- Upstream license: [MIT][upstream-license], `Copyright (c) 2023 DeepSeek`.
- Preserved license notice: [../LICENSE](../LICENSE).

The original import revision was not recorded; the comparison revision identifies
the upstream JSON used to verify the changes above.

[upstream]: https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash-Vision-Exp/blob/6821d6ad3681a4b137b066b76094fa82ebd0a380/tokenizer.json
[upstream-license]: https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash-Vision-Exp/blob/6821d6ad3681a4b137b066b76094fa82ebd0a380/LICENSE

# Kimi K3 text estimator

[`kimi-k3.tiktoken.json`](kimi-k3.tiktoken.json) is generated from Moonshot AI's
official `moonshotai/Kimi-K3` `tiktoken.model` at revision
`f831ab66814297da540d832a5235f8e904f29d06`. The original model SHA-256 is
`b6c497a7469b33ced9c38afb1ad6e47f03f5e5dc05f15930799210ec050c5103`.
[`kimi-k3.provenance.json`](kimi-k3.provenance.json) pins all source hashes,
the generated asset hash, conversion rules, and control-token IDs.

The BPE tokens and ranks are unchanged. Conversion packs them into the
`js-tiktoken@1.0.21` compressed-rank representation and makes only
semantics-preserving regex syntax adaptations required by JavaScript's `u`
flag. The converted encoder matched the official Python `tiktoken` encoder on
222 deterministic mixed-text fixtures with no mismatches.

This asset is bundled locally for **`estimated` text-only context trimming**.
It does not establish final provider-wire `counted` qualification. Runtime
downloads, remote token APIs, tool/thinking/multimodal projection, and use as
post-call `ProviderUsage` are prohibited. The upstream
[Kimi K3 License](LICENSE.kimi-k3) notice is preserved with the asset.
