# omp-home-guard

一個 [oh-my-pi](https://github.com/can1357/oh-my-pi)（omp）擴充套件，讓 agent 不能在你的家目錄裡、它正在處理的專案以外的地方刪除、覆寫或建立檔案。它靜態檢查每一個工具呼叫；在 Linux 上，還會把每一個 bash 呼叫放進 Landlock 沙箱執行：專案與暫存目錄以外的寫入由核心拒絕，指令啟動的每一個行程也一樣。

[English](README.md)

> **沒有用真實模型測過。** 實測（live tests）用腳本化的測試模型，從頭到尾跑真的 omp 18.2.8。它們證明哪些會被擋、哪些照常運作；不證明真實模型被擋之後會怎麼反應。

## 為什麼

2026-10-12，一個 coding agent 執行的測試清理程式，刪掉了打造這個套件那台機器上真正的 `~/.config`、`~/.local`、`~/.cache` 與 `~/.omp`。那個測試在 Bun 啟動之後才把 `HOME` 改成暫存目錄，但 Bun 在行程啟動時就把 `os.homedir()` 定住了，所以清理程式算出來的路徑落在真正的家目錄裡。沒有任何一個工具呼叫提到這些路徑；指令只是 `bun test`。

這個套件補的就是這個缺口。檢查工具呼叫可以擋下 `rm -rf ~/.config`，卻看不到指令啟動的行程裡發生的刪除。omp 自己的文件也說 bash 的核准「不是隔離」。Landlock 才是：Linux 行程可以放棄自己在少數幾個目錄以外的寫入權，而它之後啟動的每一個行程都會繼承這個限制，而且收不回來。

## 做什麼

| 層 | 在哪裡 | 做什麼 | 做不到時 |
|---|---|---|---|
| 靜態檢查 | 所有平台，`tool_call` | 算出 `write`、`edit`（包含改名，以及合併 patch 裡列出的檔案）、`ast_edit` 會寫到哪裡，經過 `~`、`..` 與符號連結也算，寫進受保護的地方就擋。讀 `bash` 指令：重新導向；`rm`、`mv`、`cp`、`tee`、`dd`、`sed -i`、`find -delete`、`git -C`、`tar`、`curl -o` 等指令的目標；`cd` 進受保護的地方；從那裡指派的變數；由那裡餵資料的 `xargs`；`bash -c` 與 `python -c`、`node -e` 這類內嵌程式碼。`eval` 程式碼如果提到家目錄，又會寫入、刪除或啟動行程，就擋；家目錄是在同一個 kernel 的前一次呼叫裡提到的，也算。 | omp 擋下呼叫，並告訴模型原因。 |
| 沙箱 | Linux，`bash` 的 `tool_call` | 把每一個 bash 呼叫改寫成在一個小 helper 底下執行：helper 用 Landlock 把自己的寫入權限縮到可寫的地方，再在呼叫的目錄裡把自己換成 `bash -c '<你的指令>'`。輸出、結束碼、目錄都不變；寫到別處會得到 `EACCES`。 | `onUnavailable: "warn"`（預設）：bash 只靠靜態檢查執行，這時靜態檢查變嚴格。`"block"`：擋下每一個 bash 呼叫。helper 自己限制不了自己時，以 126 結束，什麼都不執行。 |
| 通知 | `session_start` | 告訴你沙箱有沒有在跑、哪些地方可寫。 | — |

只有在靜態檢查是唯一一層時，它才會嚴格。沙箱開著時，讀不懂的指令（`python tool.py ~/data.csv`）交給沙箱；沒有沙箱時，這種指令只要提到受保護的地方就會被擋。

## 哪些地方可寫

- omp 執行所在的專案；但如果 omp 是在家目錄或更上層執行，家目錄裡就沒有任何地方可寫，通知會說明。
- 暫存目錄（`os.tmpdir()`）、`/tmp` 與 `/dev/shm`。
- 你的 `allowWrite` 項目。
- `/dev` 底下已存在的裝置檔，例如 `/dev/null` 與終端機，只能寫入。

受保護：你的家目錄與 `protect` 項目，扣掉可寫的地方。一個可寫的地方如果包含受保護的地方（例如 `allowWrite: ["~"]`，或家目錄在 `/tmp` 底下時的 `/tmp`），就會被忽略並列在通知裡，因為 Landlock 只能允許目錄，沒辦法在允許的目錄裡挖一個受保護的洞。

讀取與網路存取不受限制。

## 需求

- omp 18.2.8。
- [Bun](https://bun.sh) 1.3.14 或更新（以 1.4.2 測過）；它負責執行 helper。
- 沙箱需要：開啟 Landlock 的 Linux（kernel 5.13 以上；跨目錄搬移檔案要 5.19，截斷要 6.2）。在 kernel 7.0（Landlock ABI 8）、x86_64 上測過。macOS 與 Windows 只有靜態檢查。

## 安裝

把它 clone 到 agent 處理的所有專案**之外**，agent 才改不到 guard 本身。這個擴充套件執行時不需要任何相依套件；`bun install` 是給測試用的：

```bash
git clone <this repository> ~/omp-home-guard
cd ~/omp-home-guard && bun install
```

在 `~/.omp/agent/config.yml` 裡讓每個 session 都載入：

```yaml
extensions:
  - ~/omp-home-guard
```

或只在一次執行裡用 `omp -e ~/omp-home-guard`。如果另一個擴充套件也會改寫 bash 的輸入，讓這個最後載入：omp 執行的是最後一次改寫。

## 設定

選用，放在 `~/.config/omp-home-guard/config.json`。不從環境變數、也不從專案讀任何東西。

```json
{
  "allowWrite": ["~/.npm", "~/.bun/install/cache", "~/.cache"],
  "protect": ["/srv/data"],
  "sandbox": "landlock",
  "onUnavailable": "warn"
}
```

| 設定 | 預設 | 意思 |
|---|---|---|
| `allowWrite` | `[]` | 更多可寫的地方，絕對路徑或以 `~/` 開頭。把快取放在家目錄裡的工具（npm、Bun、pip、cargo）會得到 `EACCES`，直到它們的快取列在這裡。 |
| `protect` | `[]` | 家目錄以外更多受保護的地方。 |
| `sandbox` | `"landlock"` | `"off"` 只保留靜態檢查。 |
| `onUnavailable` | `"warn"` | `"block"`：沙箱無法執行時，擋下每一個 bash 呼叫。 |
| `bunPath` | 執行 omp 的那個 Bun，否則是 `PATH` 上的 `bun` | 執行 helper 的 Bun，絕對路徑。位在可寫地方的 Bun 會被拒絕。 |

讀不了的設定檔會在 session 開始時回報，並套用預設值。

## 沙箱怎麼運作

每一個 bash 呼叫，guard 都回傳新的 `command`，其他欄位（例如 `cwd` 與 `timeout`）維持原樣：

```sh
OMP_HOME_GUARD_BUN_OPTIONS="${BUN_OPTIONS-}" BUN_OPTIONS= '<bun>' --cwd '<state>/launch' --no-env-file \
  '<state>/helper/<hash>/sandbox-exec.ts' --cwd "$PWD" --allow '<project>' --allow '<tmp>' … --dev -- '<你的指令>'
```

`<state>` 是 `~/.local/state/omp-home-guard`；實際的指令用的是絕對路徑。

- **helper 是複本。** session 開始時，guard 把 `landlock.ts` 與 `sandbox-exec.ts` 複製到受保護的家目錄裡的 `<state>/helper/<內容雜湊>/`，再用 `--probe` 執行一次複本。只有 probe 成功限制住自己，沙箱才算可用。session 進行中套件被改動，也不會改變實際執行的東西。
- **Bun 從空目錄啟動。** Bun 會執行它啟動所在目錄的 `bunfig.toml` preload，並載入那裡的 `.env`；`--cwd` 到空的 launch 目錄加上 `--no-env-file`，讓專案的這兩樣東西進不了 helper。launch 目錄不是空的時候，bash 呼叫會被擋。
- **helper 啟動時清空 `BUN_OPTIONS`**，因為其中的 `--preload` 會在限制生效前執行；到你的指令時再還原。
- **你的指令在 omp 安排的地方執行。** omp 把 `$PWD` 設成呼叫的目錄，也照常套用那個目錄的 direnv；helper 限制住自己、切換到那個目錄，再把自己換成 `bash -c`。`skill://…` 這類內部 URL 會放在引號外，omp 照樣展開。
- **Linux 一個參數最多 128 KiB**，所以超過 120,000 位元組的指令會被擋，並提示改寫成腳本檔再執行。
- **成本：** 在打造它的 4 核心機器上，每個 bash 呼叫約多 0.23 秒（20 次的中位數），大部分是 Bun 啟動的時間。

## 測試

```bash
bun run test
```

`bun run test` 會用暫存的 `HOME` 與 `TMPDIR` 啟動 Bun；直接 `bun test` 會拒絕執行，因為測試套件會在家目錄裡建立和刪除檔案，而 Bun 在啟動時就把家目錄定住了。測試透過 omp 自己的擴充套件 loader 與 runner 執行，kernel 有 Landlock 的地方就用真的 Landlock，不需要網路。

實測用腳本化、只供測試的模型 provider（`test/scripted-provider.ts`）跑真的 omp：

```bash
HOME_GUARD_LIVE=1 OMP_CLI=/path/to/oh-my-pi/packages/coding-agent/src/cli.ts \
HOME_GUARD_LIVE_OUT=/tmp/home-guard-evidence bun run test test/live.test.ts
```

`OMP_BIN=/path/to/omp` 則改跑已安裝的 omp。沒有 guard 時，專案裡一個在執行時才組出家目錄路徑的腳本，會刪掉一個 canary 資料夾。有 guard 時，直接 `rm -rf` 那個資料夾被靜態擋下，同一個腳本被沙箱以 `EACCES` 擋住，專案內的寫入照常，`write` 到 `~/.bashrc` 被擋；指令裡和 `cwd` 裡的 `skill://` URL 在沙箱下照常運作。

## 公開發布前要做的

- **威脅模型。** 沒做（STRIDE、OWASP LLM Top 10、OWASP Agentic）。
- **安全稽核。** 沒做；helper 與靜態檢查都還沒有獨立的對抗性審查。
- **真實模型的實測。** 沒做。
- **開啟核准時的實測。** 實測用的是 `--approval-mode yolo`；omp 的核准提示如何顯示改寫後的指令，沒有檢查。
- **第一次 CI。** GitHub Actions workflow 還沒跑過；`bun.lock` 是離線產生的。
- **較新的 omp 版本。** 只測過 18.2.8，URL 的處理照著 omp 18.2.8 的規則。

## 限制

- **讀取與網路不受限制。** 家目錄裡的機密可以被讀出來、送出去。
- **Landlock 限制寫入、建立、刪除、改名與截斷，不限制中繼資料。** 權限、擁有者、時間戳記與延伸屬性不在沙箱的範圍內；靜態檢查會擋下它讀得懂的、對受保護路徑的 `chmod`、`chown` 與 `touch`。
- **只有 bash 在沙箱裡。** `eval` 在 omp 裡面（JavaScript）或在 omp 啟動的 Python kernel 裡執行，只有靜態檢查。omp 自己的寫入、它的 `memory_edit`、`learn`、`manage_skill` 與 `lsp` 工具、MCP 工具、其他擴充套件，以及你自己的 `!` 指令，都不檢查。
- **靜態檢查只讀，不執行任何東西。** 在執行時才組出路徑的指令，靜態檢查看不到；沙箱會擋住它，沒有沙箱時就沒有東西擋。
- **沙箱裡的 bash 呼叫之間不保留 shell 狀態**：你 export 的變數、定義的函式，下一次呼叫就不見了。omp 的 bash interceptor 與核准規則看到的是包裝過的指令。
- **agent 寫得到的 guard 可以被改**，影響下一個 session。請安裝在你的專案之外。
- **較舊的 kernel。** Landlock ABI 1（kernel 5.13 到 5.18）一律拒絕跨目錄搬移檔案。

## 背景

這個套件把那次事故的教訓，變成 omp agent 的 guard。同一個教訓也變成了給 Cursor agent 的規則，以及姊妹套件 omp-extension-guard 與 omp-skill-guard 裡的測試 runner：測試用暫存的家目錄啟動 Bun，否則拒絕執行；每一次遞迴刪除之前，都先確認目標在同一段程式碼自己建立的目錄裡。

## 授權

[MIT](LICENSE)
