// ツールバーの拡張機能ボタンを押したら、設定ページを開く（開いていればそのタブへ移動）
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
