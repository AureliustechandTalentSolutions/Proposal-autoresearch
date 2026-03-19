/**
 * PolicyEditor component.
 *
 * Browse and edit OpenShell YAML policies. Communicates with the Bun
 * main process via RPC to list, read, save, validate, and reload policy files.
 * Features YAML syntax validation, unsaved change tracking, and keyboard shortcuts.
 */

import type { PolicyFile } from "../app";
import { rpc } from "../app";

/** Validation status for the current editor content. */
interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

export class PolicyEditor {
  private fileList: HTMLElement;
  private editor: HTMLTextAreaElement;
  private saveBtn: HTMLButtonElement;
  private revertBtn: HTMLButtonElement;

  private files: PolicyFile[] = [];
  private activeFile: PolicyFile | null = null;
  private originalContent = "";
  private validationStatus: ValidationResult | null = null;
  private validationEl: HTMLElement | null = null;
  private searchEl: HTMLInputElement | null = null;

  constructor(
    fileList: HTMLElement,
    editor: HTMLTextAreaElement,
    saveBtn: HTMLButtonElement,
    revertBtn: HTMLButtonElement,
  ) {
    this.fileList = fileList;
    this.editor = editor;
    this.saveBtn = saveBtn;
    this.revertBtn = revertBtn;

    this.bindEvents();
    this.injectValidationBar();
    this.injectSearchBar();
  }

  /** Replace the file list with fresh data. */
  setFiles(files: PolicyFile[]): void {
    this.files = files;
    this.renderFileList();
  }

  /** Refresh the file list from the server. */
  async refreshFileList(): Promise<void> {
    try {
      const files = await rpc<PolicyFile[]>("policies.list");
      this.setFiles(files);
    } catch (err) {
      console.error("Failed to refresh policy list:", err);
    }
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private bindEvents(): void {
    this.saveBtn.addEventListener("click", () => this.handleSave());
    this.revertBtn.addEventListener("click", () => this.handleRevert());

    this.editor.addEventListener("input", () => {
      const hasChanges = this.editor.value !== this.originalContent;
      this.saveBtn.disabled = !hasChanges;
      this.revertBtn.disabled = !hasChanges;
      this.validateContent();
    });

    // Allow Tab key to insert spaces in the editor.
    this.editor.addEventListener("keydown", (e) => {
      if (e.key === "Tab") {
        e.preventDefault();
        const start = this.editor.selectionStart;
        const end = this.editor.selectionEnd;
        this.editor.value =
          this.editor.value.substring(0, start) +
          "  " +
          this.editor.value.substring(end);
        this.editor.selectionStart = this.editor.selectionEnd = start + 2;
        this.editor.dispatchEvent(new Event("input"));
      }

      // Ctrl+S / Cmd+S to save.
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        if (!this.saveBtn.disabled) {
          this.handleSave();
        }
      }
    });
  }

  private renderFileList(): void {
    let filteredFiles = this.files;

    // Apply search filter if active.
    if (this.searchEl && this.searchEl.value) {
      const query = this.searchEl.value.toLowerCase();
      filteredFiles = this.files.filter(
        (f) =>
          f.name.toLowerCase().includes(query) ||
          f.path.toLowerCase().includes(query),
      );
    }

    if (filteredFiles.length === 0) {
      this.fileList.innerHTML =
        '<li class="empty-state">No policy files found</li>';
      return;
    }

    this.fileList.innerHTML = "";

    // Group files by directory.
    const grouped: Record<string, PolicyFile[]> = {};
    for (const file of filteredFiles) {
      const dir = file.path.includes("/")
        ? file.path.substring(0, file.path.lastIndexOf("/"))
        : "root";
      if (!grouped[dir]) grouped[dir] = [];
      grouped[dir].push(file);
    }

    for (const [dir, files] of Object.entries(grouped)) {
      // Directory header.
      if (Object.keys(grouped).length > 1) {
        const header = document.createElement("li");
        header.style.cssText =
          "font-size:9px;color:var(--text-muted);padding:6px 8px 2px;text-transform:uppercase;letter-spacing:.5px;";
        header.textContent = dir.split("/").pop() ?? dir;
        this.fileList.appendChild(header);
      }

      for (const file of files) {
        const li = document.createElement("li");
        li.textContent = file.name;
        li.title = file.path;

        if (this.activeFile?.path === file.path) {
          li.classList.add("active");
        }

        // Add a dot indicator for built-in policies.
        if (file.path.startsWith("[built-in]")) {
          const dot = document.createElement("span");
          dot.style.cssText =
            "display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--blue-dim);margin-right:4px;";
          dot.title = "Built-in policy";
          li.insertBefore(dot, li.firstChild);
        }

        li.addEventListener("click", () => this.selectFile(file));
        this.fileList.appendChild(li);
      }
    }
  }

  private async selectFile(file: PolicyFile): Promise<void> {
    // Warn about unsaved changes.
    if (this.activeFile && this.editor.value !== this.originalContent) {
      const proceed = confirm(
        "You have unsaved changes. Discard and switch files?",
      );
      if (!proceed) return;
    }

    try {
      const result = await rpc<{ content: string }>("policies.read", {
        path: file.path,
      });

      this.activeFile = file;
      this.originalContent = result.content;
      this.editor.value = result.content;
      this.editor.readOnly = false;
      this.saveBtn.disabled = true;
      this.revertBtn.disabled = true;
      this.validationStatus = null;
      this.updateValidationDisplay();

      this.renderFileList();
    } catch (err) {
      console.error("Failed to read policy file:", err);
      // Show error in editor.
      this.editor.value = `# Error loading policy: ${err}`;
      this.editor.readOnly = true;
    }
  }

  private async handleSave(): Promise<void> {
    if (!this.activeFile) return;

    // Validate before saving.
    const validation = await this.validateOnServer();
    if (!validation.valid) {
      const proceed = confirm(
        `Policy has validation errors:\n${validation.errors?.join("\n")}\n\nSave anyway?`,
      );
      if (!proceed) return;
    }

    this.saveBtn.disabled = true;
    this.saveBtn.textContent = "Saving...";

    try {
      await rpc("policies.save", {
        path: this.activeFile.path,
        content: this.editor.value,
      });

      // Trigger policy reload.
      await rpc("policies.reload");

      this.originalContent = this.editor.value;
      this.saveBtn.textContent = "Saved!";
      this.saveBtn.style.background = "var(--green)";
      this.revertBtn.disabled = true;

      setTimeout(() => {
        this.saveBtn.textContent = "Save & Reload";
        this.saveBtn.style.background = "";
      }, 1500);
    } catch (err) {
      console.error("Failed to save policy:", err);
      this.saveBtn.textContent = "Save Failed";
      this.saveBtn.style.background = "var(--accent-red)";
      this.saveBtn.disabled = false;

      setTimeout(() => {
        this.saveBtn.textContent = "Save & Reload";
        this.saveBtn.style.background = "";
      }, 2000);
    }
  }

  private handleRevert(): void {
    if (!this.activeFile) return;
    this.editor.value = this.originalContent;
    this.saveBtn.disabled = true;
    this.revertBtn.disabled = true;
    this.validateContent();
  }

  /** Client-side YAML syntax validation (basic). */
  private validateContent(): void {
    if (!this.editor.value.trim()) {
      this.validationStatus = null;
      this.updateValidationDisplay();
      return;
    }

    try {
      // Basic YAML structure check: look for common errors.
      const lines = this.editor.value.split("\n");
      const errors: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Check for tab characters (YAML uses spaces).
        if (line.includes("\t")) {
          errors.push(`Line ${i + 1}: Tab character found (use spaces)`);
        }
      }

      // Check that it starts with a valid YAML field.
      const firstNonComment = lines.find(
        (l) => l.trim() && !l.trim().startsWith("#"),
      );
      if (firstNonComment && !firstNonComment.match(/^\s*[\w-]+\s*:/)) {
        errors.push("First field should be a key-value pair (e.g. 'name: ...')");
      }

      this.validationStatus =
        errors.length > 0
          ? { valid: false, errors }
          : { valid: true };
    } catch {
      this.validationStatus = { valid: false, errors: ["Parse error"] };
    }

    this.updateValidationDisplay();
  }

  /** Server-side policy schema validation. */
  private async validateOnServer(): Promise<ValidationResult> {
    try {
      const result = await rpc<{ valid: boolean; errors?: string[] }>(
        "policy:validate",
        { policy: this.editor.value },
      );
      return result;
    } catch {
      return { valid: true }; // Fallback: don't block save.
    }
  }

  private injectValidationBar(): void {
    const parent = this.editor.parentElement;
    if (!parent) return;

    this.validationEl = document.createElement("div");
    this.validationEl.style.cssText =
      "font-size:10px;padding:4px 8px;display:none;border-radius:3px;margin-bottom:4px;";
    parent.insertBefore(this.validationEl, this.editor);
  }

  private injectSearchBar(): void {
    const parent = this.fileList.parentElement;
    if (!parent) return;

    this.searchEl = document.createElement("input");
    this.searchEl.type = "text";
    this.searchEl.placeholder = "Filter policies...";
    this.searchEl.style.cssText =
      "width:100%;padding:4px 6px;font-size:10px;background:var(--bg-input);border:1px solid var(--border);border-radius:3px;color:var(--text-primary);margin-bottom:6px;outline:none;";
    this.searchEl.addEventListener("input", () => this.renderFileList());
    parent.insertBefore(this.searchEl, this.fileList);
  }

  private updateValidationDisplay(): void {
    if (!this.validationEl) return;

    if (!this.validationStatus) {
      this.validationEl.style.display = "none";
      return;
    }

    this.validationEl.style.display = "block";

    if (this.validationStatus.valid) {
      this.validationEl.style.background = "var(--green-dim)";
      this.validationEl.style.color = "var(--green)";
      this.validationEl.textContent = "YAML valid";
    } else {
      this.validationEl.style.background = "var(--accent-red-dim)";
      this.validationEl.style.color = "var(--accent-red)";
      this.validationEl.textContent =
        this.validationStatus.errors?.join(" | ") ?? "Validation error";
    }
  }
}
