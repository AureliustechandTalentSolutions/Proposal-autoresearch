/**
 * PolicyEditor component.
 *
 * Browse and edit OpenShell YAML policies.  Communicates with the Bun
 * main process via RPC to list, read, save, and reload policy files.
 */

import type { PolicyFile } from "../app";
import { rpc } from "../app";

export class PolicyEditor {
  private fileList: HTMLElement;
  private editor: HTMLTextAreaElement;
  private saveBtn: HTMLButtonElement;
  private revertBtn: HTMLButtonElement;

  private files: PolicyFile[] = [];
  private activeFile: PolicyFile | null = null;
  private originalContent = "";

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
    });

    // Allow Tab key to insert spaces in the editor
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
    });
  }

  private renderFileList(): void {
    if (this.files.length === 0) {
      this.fileList.innerHTML = '<li class="empty-state">No policy files found</li>';
      return;
    }

    this.fileList.innerHTML = "";

    for (const file of this.files) {
      const li = document.createElement("li");
      li.textContent = file.name;
      li.title = file.path;

      if (this.activeFile?.path === file.path) {
        li.classList.add("active");
      }

      li.addEventListener("click", () => this.selectFile(file));
      this.fileList.appendChild(li);
    }
  }

  private async selectFile(file: PolicyFile): Promise<void> {
    // Warn about unsaved changes
    if (
      this.activeFile &&
      this.editor.value !== this.originalContent
    ) {
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

      this.renderFileList();
    } catch (err) {
      console.error("Failed to read policy file:", err);
    }
  }

  private async handleSave(): Promise<void> {
    if (!this.activeFile) return;

    this.saveBtn.disabled = true;
    this.saveBtn.textContent = "Saving...";

    try {
      await rpc("policies.save", {
        path: this.activeFile.path,
        content: this.editor.value,
      });

      // Trigger OPA policy reload
      await rpc("policies.reload");

      this.originalContent = this.editor.value;
      this.saveBtn.textContent = "Saved!";
      this.revertBtn.disabled = true;

      setTimeout(() => {
        this.saveBtn.textContent = "Save & Reload";
      }, 1500);
    } catch (err) {
      console.error("Failed to save policy:", err);
      this.saveBtn.textContent = "Save Failed";
      this.saveBtn.disabled = false;

      setTimeout(() => {
        this.saveBtn.textContent = "Save & Reload";
      }, 2000);
    }
  }

  private handleRevert(): void {
    if (!this.activeFile) return;
    this.editor.value = this.originalContent;
    this.saveBtn.disabled = true;
    this.revertBtn.disabled = true;
  }
}
