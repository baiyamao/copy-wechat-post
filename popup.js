const STORAGE_KEY = "wechatArticleSectionsHtml";

const statusElement = document.getElementById("status");
const copyButton = document.getElementById("copyBtn");
const pasteButton = document.getElementById("pasteBtn");

copyButton.addEventListener("click", copyFromCurrentTab);
pasteButton.addEventListener("click", pasteToCurrentTab);

async function copyFromCurrentTab() {
  setBusy(true);

  try {
    const tab = await getActiveTab();
    const result = await executeInTab(tab.id, extractArticleSections);

    await chrome.storage.local.remove(STORAGE_KEY);
    await chrome.storage.local.set({
      [STORAGE_KEY]: {
        html: result.html,
        sectionCount: result.sectionCount,
        sourceUrl: tab.url,
        copiedAt: new Date().toISOString(),
        fingerprint: result.fingerprint,
      },
    });

    const stored = await chrome.storage.local.get(STORAGE_KEY);

    if (stored[STORAGE_KEY]?.fingerprint !== result.fingerprint) {
      throw new Error("复制失败：写入校验未通过，请重试。");
    }

    setStatus(
      `已复制 ${result.sectionCount} 个正文 section，长度 ${result.html.length} 字符。`
    );
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    setBusy(false);
  }
}

async function pasteToCurrentTab() {
  setBusy(true);

  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const record = stored[STORAGE_KEY];

    if (!record?.html) {
      throw new Error("尚未复制文章源码。");
    }

    const tab = await getActiveTab();
    const result = await executeInTab(tab.id, replaceEditorSections, [
      record.html,
      record.fingerprint,
    ]);

    setStatus(result.message);
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    setBusy(false);
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id) {
    throw new Error("未找到当前标签页。");
  }

  return tab;
}

async function executeInTab(tabId, func, args = []) {
  const injectionResults = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });
  const result = injectionResults?.[0]?.result;

  if (!result?.ok) {
    throw new Error(result?.message || "操作失败：页面脚本没有返回结果。");
  }

  return result;
}

function setBusy(isBusy) {
  copyButton.disabled = isBusy;
  pasteButton.disabled = isBusy;
}

function setStatus(message, isError = false) {
  statusElement.textContent = message;
  statusElement.style.color = isError ? "#cf222e" : "#57606a";
}

function extractArticleSections() {
  try {
    const content = document.querySelector("#js_content");

    if (!content) {
      return {
        ok: false,
        message: "未找到文章正文容器 #js_content。",
      };
    }

    const sections = getTopLevelSections(content);

    if (sections.length === 0) {
      return {
        ok: false,
        message: "未找到可复制的正文 section。",
      };
    }

    const html = sections.map((section) => section.outerHTML).join("\n");

    return {
      ok: true,
      html,
      sectionCount: sections.length,
      fingerprint: createFingerprint(html),
    };
  } catch (error) {
    return {
      ok: false,
      message: `复制失败：${error.message || String(error)}`,
    };
  }

  function getTopLevelSections(root) {
    const directSections = Array.from(root.querySelectorAll(":scope > section"));

    if (directSections.length > 0) {
      return directSections;
    }

    return Array.from(root.querySelectorAll("section")).filter((section) => {
      const parentSection = section.parentElement?.closest("section");
      return !parentSection || !root.contains(parentSection);
    });
  }

  function createFingerprint(text) {
    let hash = 0;

    for (let index = 0; index < text.length; index += 1) {
      hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
    }

    return `${text.length}:${hash}`;
  }
}

function replaceEditorSections(html, fingerprint) {
  try {
    const editor = document.querySelector("#ueditor_0 .ProseMirror");

    if (!editor) {
      return {
        ok: false,
        message: "未找到公众号后台编辑器 #ueditor_0 .ProseMirror。",
      };
    }

    const targetSections = getTopLevelSections(editor);

    if (targetSections.length === 0) {
      return {
        ok: false,
        message: "编辑器内未找到可替换的 section。",
      };
    }

    const template = document.createElement("template");
    template.innerHTML = html.trim();
    const sourceSections = Array.from(template.content.children);

    if (
      sourceSections.length === 0 ||
      sourceSections.some((element) => element.tagName.toLowerCase() !== "section")
    ) {
      return {
        ok: false,
        message: "已保存内容不是有效的 section 源码集合。",
      };
    }

    const firstTargetSection = targetSections[0];
    const fragment = document.createDocumentFragment();

    for (const sourceSection of sourceSections) {
      fragment.appendChild(sourceSection);
    }

    firstTargetSection.replaceWith(fragment);

    for (const section of targetSections.slice(1)) {
      section.remove();
    }

    editor.focus();
    notifyEditorChanged(editor, html);

    return {
      ok: true,
      message: `已替换编辑器内 ${targetSections.length} 个 section。校验 ${fingerprint}。`,
    };
  } catch (error) {
    return {
      ok: false,
      message: `粘贴失败：${error.message || String(error)}`,
    };
  }

  function getTopLevelSections(root) {
    const directSections = Array.from(root.querySelectorAll(":scope > section"));

    if (directSections.length > 0) {
      return directSections;
    }

    return Array.from(root.querySelectorAll("section")).filter((section) => {
      const parentSection = section.parentElement?.closest("section");
      return !parentSection || !root.contains(parentSection);
    });
  }

  function notifyEditorChanged(target, html) {
    const events = [
      new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertHTML",
        data: html,
      }),
      new Event("change", { bubbles: true }),
    ];

    for (const event of events) {
      target.dispatchEvent(event);
    }

    target.closest(".view")?.dispatchEvent(new Event("input", { bubbles: true }));
  }
}
