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

The asset provides a local **`estimated`** input-content size for DeepSeek model
family names. Common-input text content includes declared tool definitions, tool
calls/results, and thinking text. It never reconstructs the final provider request,
establishes `counted` qualification, or replaces post-call `ProviderUsage`.
Multimodal/unknown input and asset failures remain `unavailable`.

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

This asset is bundled locally for **`estimated` common-input context trimming**
selected by Kimi model family names (including fixed `k3` aliases). Runtime
measurement encodes text content from messages, declared tool definitions, tool
calls/results, and thinking without provider chat markup or final-wire projection.
Multimodal and unknown content remains `unavailable`. Downloads, remote token APIs,
final-wire counting, and use as post-call `ProviderUsage` are prohibited.

Each common-input text segment is encoded independently in chunks of at most
25,000 Unicode code points, and the chunk counts are summed. Splitting preserves
every code point and its order without normalization: valid surrogate pairs stay
intact, although grapheme clusters may cross a boundary. Tokenizer merges and
pre-tokenization cannot cross these artificial boundaries, so whole-text
equivalence and any error bound are not guaranteed; results never represent
provider usage. The upstream [Kimi K3 License](LICENSE.kimi-k3) notice is
preserved with the asset.

# Qwen3.8 text estimator

[`qwen3.8.tokenizer.json`](qwen3.8.tokenizer.json) is a verbatim copy of the
official `Qwen/Qwen3.8-27B` `tokenizer.json` at revision
`37561816e66b5b9153b1b64c10968c18c1e6f4a0`. Its SHA-256 is
`0997f410c57a1f4e53b09e4be8f4a172d90edd9564368fb0847030937229b9f3`.
[`qwen3.8.provenance.json`](qwen3.8.provenance.json) pins the source, config,
asset, license, conversion decision, and projection control-token IDs.

`@huggingface/tokenizers@0.2.0` loads the official JSON directly, so no lossy or
handwritten vocabulary conversion is needed. Runtime plain-text encoding removes
`added_tokens` and measures input content without reconstructing IM/chat markup.
Any Qwen added/control token appearing in user text makes the estimate
unavailable instead of being silently interpreted as wire syntax.

This asset is bundled locally for **`estimated` common-input context trimming**
selected by Qwen model family names. Text content from declared tool definitions,
tool calls/results, and thinking is included without reconstructing provider wire
templates. Multimodal and unknown content remains `unavailable`. Runtime downloads,
remote token APIs, final-wire counting, and use as post-call `ProviderUsage` are
prohibited.

Each common-input text segment is encoded independently in chunks of at most
25,000 Unicode code points, and the chunk counts are summed. Splitting preserves
every code point and its order without normalization: valid surrogate pairs stay
intact, although grapheme clusters may cross a boundary. Tokenizer merges and
pre-tokenization cannot cross these artificial boundaries, so whole-text
equivalence and any error bound are not guaranteed; results never represent
provider usage. The upstream [Apache License 2.0](LICENSE.qwen3.8) notice is
preserved with the asset.

# GLM-5.3 text estimator

[`glm53.tokenizer.json`](glm53.tokenizer.json) is a verbatim copy of the
official `zai-org/GLM-5.3` `tokenizer.json` at revision
`ba32f8c19c8738e2c57c71798c601d477a7bf844`. Its SHA-256 is
`19e773648cb4e65de8660ea6365e10acca112d42a854923df93db4a6f333a82d`.
[`glm53.provenance.json`](glm53.provenance.json) pins the tokenizer, model and
tokenizer configs, chat template, license, conversion decision, and projection
control-token IDs.

`@huggingface/tokenizers@0.2.0` loads the official JSON directly. Runtime
plain-text encoding removes `added_tokens` and measures common-input text content,
including declared tool definitions, tool calls/results, and thinking, without
reconstructing role markers or chat templates. Any GLM added/control token in
plain text makes the estimate unavailable instead of being interpreted as wire
syntax. Multimodal and unknown inputs are unsupported.

One asset covers GLM model family names as a **model-family approximation**,
independent of provider, API protocol, wire model, or endpoint. GLM-4.x and
GLM-5.x vocabularies differ, so results remain **`estimated`** for context
trimming and never become post-call `ProviderUsage`. Runtime downloads, remote
token APIs, and final-wire projections are prohibited.

Each common-input text segment is encoded independently in chunks of at most
25,000 Unicode code points, and the chunk counts are summed. Splitting preserves
every code point and its order without normalization: valid surrogate pairs stay
intact, although grapheme clusters may cross a boundary. Tokenizer merges and
pre-tokenization cannot cross these artificial boundaries, so whole-text
equivalence and any error bound are not guaranteed; results never represent
provider usage. The upstream [GLM-5.3 License](LICENSE.glm53) notice is
preserved with the asset.
