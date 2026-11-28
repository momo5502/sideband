import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { forwardRef, memo, useLayoutEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { ArrowDown, ArrowUp, LoaderCircle, MoreHorizontal, X } from "lucide-react";
import { clsx } from "clsx";
import { messageMarkdown } from "./browser-markdown.js";
export const Button = forwardRef(function Button({ className, variant = "outline", icon, type = "button", ...props }, ref) {
    return _jsx("button", { ref: ref, type: type, className: clsx("button", `button-${variant}`, icon && "icon-button", className), ...props });
});
export function Modal({ open, onOpenChange, title, description, children, className, id, returnFocus }) {
    const previousFocus = useRef(document.activeElement);
    return _jsx(Dialog.Root, { open: open, onOpenChange: onOpenChange, children: _jsxs(Dialog.Portal, { children: [_jsx(Dialog.Overlay, { className: "dialog-overlay" }), _jsxs(Dialog.Content, { id: id, className: clsx("dialog-content", className), "aria-describedby": description ? `${id ?? "modal"}-description` : undefined, onCloseAutoFocus: event => {
                        event.preventDefault();
                        const target = returnFocus ? document.querySelector(returnFocus) : previousFocus.current?.isConnected ? previousFocus.current : document.querySelector("#new-agent") ?? document.querySelector("#menu-toggle");
                        target?.focus();
                    }, children: [_jsxs("div", { className: "dialog-heading", children: [_jsxs("div", { children: [_jsx(Dialog.Title, { className: "dialog-title", children: title }), description && _jsx(Dialog.Description, { id: `${id ?? "modal"}-description`, className: "dialog-description", children: description })] }), _jsx(Dialog.Close, { asChild: true, children: _jsx(Button, { variant: "ghost", icon: true, "aria-label": "Close dialog", children: _jsx(X, { size: 18 }) }) })] }), children] })] }) });
}
export function Menu({ label, children }) {
    const trigger = useRef(null);
    return _jsxs(Dropdown.Root, { children: [_jsx(Dropdown.Trigger, { asChild: true, children: _jsx(Button, { ref: trigger, variant: "ghost", icon: true, "aria-label": label, children: _jsx(MoreHorizontal, { size: 19 }) }) }), _jsx(Dropdown.Portal, { children: _jsx(Dropdown.Content, { className: "dropdown-content", align: "end", sideOffset: 7, onCloseAutoFocus: event => {
                        if (document.querySelector('[role="dialog"]'))
                            event.preventDefault();
                        else
                            trigger.current?.focus();
                    }, children: children }) })] });
}
export function MenuItem({ children, onSelect, disabled, danger, defer, title }) {
    return _jsx(Dropdown.Item, { title: title, className: clsx("dropdown-item", danger && "text-danger"), disabled: disabled, onSelect: () => { if (defer)
            window.setTimeout(onSelect, 0);
        else
            onSelect(); }, children: children });
}
export function Field({ label, hint, children, htmlFor }) {
    return _jsxs("div", { className: "field", children: [_jsx("label", { htmlFor: htmlFor, children: label }), children, hint && _jsx("p", { className: "field-hint", children: hint })] });
}
let markdown;
export const Markdown = memo(function Markdown({ text, className }) {
    const ref = useRef(null);
    useLayoutEffect(() => { markdown ??= messageMarkdown(window); ref.current?.replaceChildren(markdown(text)); }, [text]);
    return _jsx("div", { ref: ref, className: clsx("markdown", className) });
});
export function ErrorMessage({ text, id }) { return text ? _jsx("p", { id: id, className: "inline-error", role: "alert", children: text }) : null; }
export function Spinner({ size = 16 }) { return _jsx(LoaderCircle, { size: size, className: "animate-spin", "aria-hidden": "true" }); }
export function useLogScroll(ref, view, tail, label = "New messages") {
    const nearBottom = useRef(true), last = useRef({ view, tail });
    const [unread, setUnread] = useState(false);
    useLayoutEffect(() => {
        if (last.current.view !== view) {
            nearBottom.current = true;
            setUnread(false);
        }
        if (last.current.tail !== tail || last.current.view !== view) {
            if (nearBottom.current && ref.current)
                ref.current.scrollTop = ref.current.scrollHeight;
            else
                setUnread(true);
        }
        last.current = { view, tail };
    }, [view, tail, ref]);
    const onScroll = () => { const node = ref.current; if (node) {
        nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100;
        if (nearBottom.current)
            setUnread(false);
    } };
    return { onScroll, jump: unread ? _jsxs(Button, { variant: "outline", className: "new-output", onClick: () => { if (ref.current)
                ref.current.scrollTop = ref.current.scrollHeight; nearBottom.current = true; setUnread(false); }, children: [_jsx(ArrowDown, { size: 14 }), label] }) : null };
}
export function Composer({ id, placeholder, context, disabled, onSend, drafts, draftKey, room = false }) {
    const [sending, setSending] = useState(false), [error, setError] = useState("");
    const field = useRef(null);
    return _jsxs("form", { id: room ? "compose" : "agent-instructions", className: "composer", "data-sending": sending || undefined, onSubmit: event => {
            event.preventDefault();
            const input = field.current, text = input?.value ?? "";
            if (!text.trim() || disabled || sending)
                return;
            setSending(true);
            setError("");
            drafts.set(draftKey, text);
            void onSend(text).then(() => {
                if (drafts.get(draftKey) === text)
                    drafts.delete(draftKey);
                if (input?.value === text) {
                    input.value = "";
                    input.style.height = "";
                }
            }).catch(error => setError(error instanceof Error ? error.message : "Message could not be sent.")).finally(() => { setSending(false); input?.focus(); });
        }, children: [_jsxs("div", { className: "composer-box", children: [_jsx("textarea", { id: id, ref: field, name: "message", "aria-label": room ? "Message" : "Private instructions", placeholder: placeholder, rows: 1, maxLength: room ? 8192 : 16000, defaultValue: drafts.get(draftKey) ?? "", disabled: disabled, onInput: event => {
                            const input = event.currentTarget;
                            drafts.set(draftKey, input.value);
                            input.style.height = "auto";
                            input.style.height = `${Math.min(160, Math.max(40, input.scrollHeight))}px`;
                        }, onKeyDown: event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                            event.preventDefault();
                            event.currentTarget.form?.requestSubmit();
                        } } }), _jsx(Button, { id: room ? "send" : "agent-prompt-send", type: "submit", variant: "primary", icon: true, "aria-label": room ? "Send message" : "Send instructions", disabled: disabled || sending, children: sending ? _jsx(Spinner, {}) : _jsx(ArrowUp, { size: 18 }) })] }), _jsxs("div", { className: "composer-caption", children: [_jsx("span", { children: context }), _jsx("span", { className: "keyboard-hint", children: "Enter to send \u00B7 Shift+Enter for a new line" })] }), _jsx(ErrorMessage, { text: error })] });
}
//# sourceMappingURL=browser-components.js.map