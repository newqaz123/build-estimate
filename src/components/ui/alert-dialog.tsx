"use client";

import * as React from "react";
import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { XIcon } from "lucide-react";

/**
 * Alert dialog wrappers around `@base-ui/react/alert-dialog`.
 *
 * Unlike the regular dialog, an alert dialog cannot be dismissed by clicking
 * the backdrop or pressing Escape — the caller must provide explicit Cancel /
 * confirm actions. `Content` composes Portal + Backdrop + Popup and forwards
 * `initialFocus` to the popup so a confirm flow can focus its destructive
 * action (or, more safely, the cancel action).
 */
function AlertDialog({ ...props }: AlertDialogPrimitive.Root.Props) {
	return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />;
}

function AlertDialogTrigger({ ...props }: AlertDialogPrimitive.Trigger.Props) {
	return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />;
}

function AlertDialogPortal({ ...props }: AlertDialogPrimitive.Portal.Props) {
	return <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />;
}

// Forward the close ref so callers can attach a focus target (e.g. the Cancel
// action) and pass it back to the popup via `initialFocus`.
function AlertDialogClose({
	ref,
	...props
}: AlertDialogPrimitive.Close.Props & {
	ref?: React.Ref<HTMLButtonElement>;
}) {
	return (
		<AlertDialogPrimitive.Close ref={ref} data-slot="alert-dialog-close" {...props} />
	);
}

function AlertDialogContent({
	className,
	children,
	initialFocus,
	showCloseButton = true,
	...props
}: AlertDialogPrimitive.Popup.Props & {
	showCloseButton?: boolean;
}) {
	return (
		<AlertDialogPortal>
			<AlertDialogPrimitive.Backdrop
				data-slot="alert-dialog-backdrop"
				className="fixed inset-0 isolate z-50 bg-black/30 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
			/>
			<AlertDialogPrimitive.Popup
				data-slot="alert-dialog-content"
				initialFocus={initialFocus}
				className={cn(
					"alert-dialog-content fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
					className,
				)}
				{...props}
			>
				{children}
				{showCloseButton && (
					<AlertDialogPrimitive.Close
						data-slot="alert-dialog-close"
						data-od-id="alert-dialog-close"
						render={
							<Button
								variant="ghost"
								className="absolute top-2 right-2"
								size="icon-sm"
							/>
						}
					>
						<XIcon />
						<span className="sr-only">Close</span>
					</AlertDialogPrimitive.Close>
				)}
			</AlertDialogPrimitive.Popup>
		</AlertDialogPortal>
	);
}

function AlertDialogHeader({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="alert-dialog-header"
			className={cn("flex flex-col gap-2", className)}
			{...props}
		/>
	);
}

function AlertDialogFooter({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="alert-dialog-footer"
			className={cn(
				"-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end",
				className,
			)}
			{...props}
		/>
	);
}

function AlertDialogTitle({ className, ...props }: AlertDialogPrimitive.Title.Props) {
	return (
		<AlertDialogPrimitive.Title
			data-slot="alert-dialog-title"
			className={cn("font-heading text-base leading-none font-medium", className)}
			{...props}
		/>
	);
}

function AlertDialogDescription({
	className,
	...props
}: AlertDialogPrimitive.Description.Props) {
	return (
		<AlertDialogPrimitive.Description
			data-slot="alert-dialog-description"
			className={cn(
				"text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
				className,
			)}
			{...props}
		/>
	);
}

export {
	AlertDialog,
	AlertDialogClose,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogPortal,
	AlertDialogTrigger,
};
