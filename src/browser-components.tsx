import { forwardRef, memo, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { ArrowDown, ArrowUp, LoaderCircle, MoreHorizontal, X } from "lucide-react";
import { clsx } from "clsx";
import { messageMarkdown } from "./browser-markdown.js";

export const Button = forwardRef<HTMLButtonElement, ComponentProps<"button"> & { variant?: "primary" | "ghost" | "danger" | "outline"; icon?: boolean }>(function Button({ className, variant = "outline", icon, type = "button", ...props }, ref) {
  return <button ref={ref} type={type} className={clsx("button", `button-${variant}`, icon && "icon-button", className)} {...props} />;
});
export function Modal({ open, onOpenChange, title, description, children, className, id, returnFocus }: { open: boolean; onOpenChange(open: boolean): void; title: string; description?: string; children: ReactNode; className?: string; id?: string; returnFocus?: string }) {
  const previousFocus = useRef(document.activeElement as HTMLElement | null);
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" />
    <Dialog.Content id={id} className={clsx("dialog-content", className)} aria-describedby={description ? `${id ?? "modal"}-description` : undefined} onCloseAutoFocus={event => {
      event.preventDefault();
      const target = returnFocus ? document.querySelector<HTMLElement>(returnFocus) : previousFocus.current?.isConnected ? previousFocus.current : document.querySelector<HTMLElement>("#new-agent") ?? document.querySelector<HTMLElement>("#menu-toggle"); target?.focus();
    }}>
      <div className="dialog-heading"><div><Dialog.Title className="dialog-title">{title}</Dialog.Title>{description && <Dialog.Description id={`${id ?? "modal"}-description`} className="dialog-description">{description}</Dialog.Description>}</div>
        <Dialog.Close asChild><Button variant="ghost" icon aria-label="Close dialog"><X size={18} /></Button></Dialog.Close></div>
      {children}
    </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
export function Menu({ label, children }: { label: string; children: ReactNode }) {
  const trigger = useRef<HTMLButtonElement>(null);
  return <Dropdown.Root><Dropdown.Trigger asChild><Button ref={trigger} variant="ghost" icon aria-label={label}><MoreHorizontal size={19} /></Button></Dropdown.Trigger>
    <Dropdown.Portal><Dropdown.Content className="dropdown-content" align="end" sideOffset={7} onCloseAutoFocus={event => {
      if (document.querySelector('[role="dialog"]')) event.preventDefault();
      else trigger.current?.focus();
    }}>{children}</Dropdown.Content></Dropdown.Portal></Dropdown.Root>;
}
export function MenuItem({ children, onSelect, disabled, danger, defer, title }: { children: ReactNode; onSelect(): void; disabled?: boolean; danger?: boolean; defer?: boolean; title?: string }) {
  return <Dropdown.Item title={title} className={clsx("dropdown-item", danger && "text-danger")} disabled={disabled} onSelect={() => { if (defer) window.setTimeout(onSelect, 0); else onSelect(); }}>{children}</Dropdown.Item>;
}
export function Field({ label, hint, children, htmlFor }: { label: string; hint?: string; children: ReactNode; htmlFor: string }) {
  return <div className="field"><label htmlFor={htmlFor}>{label}</label>{children}{hint && <p className="field-hint">{hint}</p>}</div>;
}
let markdown: ReturnType<typeof messageMarkdown> | undefined;
export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { markdown ??= messageMarkdown(window); ref.current?.replaceChildren(markdown(text)); }, [text]);
  return <div ref={ref} className={clsx("markdown", className)} />;
});
export function ErrorMessage({ text, id }: { text?: string; id?: string }) { return text ? <p id={id} className="inline-error" role="alert">{text}</p> : null; }
export function Spinner({ size = 16 }: { size?: number }) { return <LoaderCircle size={size} className="animate-spin" aria-hidden="true" />; }

export function useLogScroll(ref: RefObject<HTMLDivElement | null>, view: string, tail: string, label = "New messages") {
  const nearBottom = useRef(true), last = useRef({ view, tail });
  const [unread, setUnread] = useState(false);
  useLayoutEffect(() => {
    if (last.current.view !== view) { nearBottom.current = true; setUnread(false); }
    if (last.current.tail !== tail || last.current.view !== view) {
      if (nearBottom.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
      else setUnread(true);
    }
    last.current = { view, tail };
  }, [view, tail, ref]);
  const onScroll = () => { const node = ref.current; if (node) { nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100; if (nearBottom.current) setUnread(false); } };
  return { onScroll, jump: unread ? <Button variant="outline" className="new-output" onClick={() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; nearBottom.current = true; setUnread(false); }}><ArrowDown size={14} />{label}</Button> : null };
}
export function Composer({ id, placeholder, context, disabled, onSend, drafts, draftKey, room = false }: { id: string; placeholder: string; context: ReactNode; disabled: boolean; onSend(text: string): Promise<unknown>; drafts: Map<string, string>; draftKey: string; room?: boolean }) {
  const [sending, setSending] = useState(false), [error, setError] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  return <form id={room ? "compose" : "agent-instructions"} className="composer" data-sending={sending || undefined} onSubmit={event => {
    event.preventDefault(); const input = field.current, text = input?.value ?? ""; if (!text.trim() || disabled || sending) return;
    setSending(true); setError(""); drafts.set(draftKey, text);
    void onSend(text).then(() => {
      if (drafts.get(draftKey) === text) drafts.delete(draftKey);
      if (input?.value === text) { input.value = ""; input.style.height = ""; }
    }).catch(error => setError(error instanceof Error ? error.message : "Message could not be sent.")).finally(() => { setSending(false); input?.focus(); });
  }}>
    <div className="composer-box"><textarea id={id} ref={field} name="message" aria-label={room ? "Message" : "Private instructions"} placeholder={placeholder} rows={1} maxLength={room ? 8192 : 16000}
      defaultValue={drafts.get(draftKey) ?? ""} disabled={disabled} onInput={event => {
        const input = event.currentTarget; drafts.set(draftKey, input.value); input.style.height = "auto"; input.style.height = `${Math.min(160, Math.max(40, input.scrollHeight))}px`;
      }} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
      <Button id={room ? "send" : "agent-prompt-send"} type="submit" variant="primary" icon aria-label={room ? "Send message" : "Send instructions"} disabled={disabled || sending}>{sending ? <Spinner /> : <ArrowUp size={18} />}</Button></div>
    <div className="composer-caption"><span>{context}</span><span className="keyboard-hint">Enter to send · Shift+Enter for a new line</span></div><ErrorMessage text={error} />
  </form>;
}
