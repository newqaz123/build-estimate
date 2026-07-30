'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Combobox as ComboboxPrimitive } from '@base-ui/react/combobox'
import { Check, ChevronDown, Plus, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  filterUnits,
  findCanonicalUnit,
  MAX_UNIT_LENGTH,
  normalizeWorkspaceUnit,
} from '@/lib/units'

export interface UnitComboboxProps {
  value: string
  units: string[]
  onChange: (unit: string) => void
  onAddUnit: (unit: string) => Promise<string> | string | void
  workspaceLoadError?: string | null
  disabled?: boolean
  readOnly?: boolean
  ariaLabel?: string
}

function getAddErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return 'Unable to add workspace unit.'
}

export function UnitCombobox({
  value,
  units,
  onChange,
  onAddUnit,
  workspaceLoadError,
  disabled,
  readOnly,
  ariaLabel = 'Unit',
}: UnitComboboxProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [addingUnit, setAddingUnit] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const addInputRef = useRef<HTMLInputElement>(null)
  const addOperationGenerationRef = useRef(0)
  const addInputId = useId()
  const filteredUnits = filterUnits(units, query)

  const resetPopupState = useCallback(() => {
    setOpen(false)
    setQuery('')
    setAdding(false)
    setDraft('')
    setAddError(null)
  }, [])

  const invalidateAddOperation = useCallback(() => {
    addOperationGenerationRef.current += 1
    setAddingUnit(false)
  }, [])

  const closePopup = useCallback(() => {
    invalidateAddOperation()
    resetPopupState()
  }, [invalidateAddOperation, resetPopupState])

  const selectUnit = useCallback((unit: string) => {
    invalidateAddOperation()
    onChange(unit)
    resetPopupState()
  }, [invalidateAddOperation, onChange, resetPopupState])

  const cancelAdd = () => {
    setAdding(false)
    setDraft('')
    setAddError(null)
  }

  useEffect(() => {
    if (!open || readOnly) return
    if (adding) addInputRef.current?.focus()
    else searchRef.current?.focus()
  }, [adding, open, readOnly])

  useEffect(() => {
    if (!open || readOnly) return

    const scrollContainer = triggerRef.current?.closest<HTMLElement>(
      '.unified-boq-table-scroll',
    )
    const closeForLayoutChange = () => closePopup()

    window.addEventListener('resize', closeForLayoutChange)
    scrollContainer?.addEventListener('scroll', closeForLayoutChange)

    return () => {
      window.removeEventListener('resize', closeForLayoutChange)
      scrollContainer?.removeEventListener('scroll', closeForLayoutChange)
    }
  }, [closePopup, open, readOnly])

  if (readOnly) {
    return <span className="unit-combobox-readonly">{value || '—'}</span>
  }

  const commitAdd = async () => {
    if (addingUnit) return
    setAddError(null)

    let unit: string
    try {
      unit = normalizeWorkspaceUnit(draft)
    } catch (error) {
      setAddError(getAddErrorMessage(error))
      return
    }

    const existingUnit = findCanonicalUnit(units, unit)
    if (existingUnit) {
      selectUnit(existingUnit)
      return
    }

    const operationGeneration = ++addOperationGenerationRef.current
    setAddingUnit(true)
    let canonical = unit
    try {
      canonical = (await onAddUnit(unit)) ?? unit
    } catch (error) {
      if (addOperationGenerationRef.current === operationGeneration) {
        setAddError(getAddErrorMessage(error))
      }
      return
    } finally {
      if (addOperationGenerationRef.current === operationGeneration) {
        setAddingUnit(false)
      }
    }

    if (addOperationGenerationRef.current !== operationGeneration) return
    selectUnit(canonical)
  }

  return (
    <div className="unit-combobox" data-od-id="unit-combobox">
      <ComboboxPrimitive.Root<string>
        items={units}
        filteredItems={filteredUnits}
        filter={null}
        value={value || null}
        open={open}
        inputValue={query}
        autoHighlight
        modal={false}
        disabled={disabled}
        onInputValueChange={setQuery}
        onOpenChange={(nextOpen) => {
          if (nextOpen) setOpen(true)
          else closePopup()
        }}
        onValueChange={(unit) => {
          if (!unit) return
          selectUnit(unit)
        }}
      >
        <ComboboxPrimitive.Trigger
          ref={triggerRef}
          render={
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="unit-combobox-trigger"
              disabled={disabled}
              aria-label={ariaLabel}
            />
          }
        >
          <span className="unit-combobox-value">{value || 'Unit…'}</span>
          <ChevronDown aria-hidden="true" />
        </ComboboxPrimitive.Trigger>

        <ComboboxPrimitive.Portal>
          <ComboboxPrimitive.Positioner
            align="start"
            sideOffset={4}
            collisionPadding={8}
            className="unit-combobox-positioner"
          >
            <ComboboxPrimitive.Popup
              className="unit-combobox-popover"
              initialFocus={adding ? addInputRef : searchRef}
              finalFocus={triggerRef}
            >
              {adding ? (
                <form
                  className="unit-combobox-add-form"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void commitAdd()
                  }}
                >
                  <label htmlFor={addInputId}>Workspace unit</label>
                  <Input
                    id={addInputId}
                    ref={addInputRef}
                    value={draft}
                    maxLength={MAX_UNIT_LENGTH}
                    disabled={addingUnit}
                    aria-invalid={addError ? true : undefined}
                    autoComplete="off"
                    onChange={(event) => {
                      setDraft(event.target.value)
                      setAddError(null)
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Escape') return
                      event.preventDefault()
                      event.stopPropagation()
                      cancelAdd()
                    }}
                  />
                  <p className="unit-combobox-add-hint">
                    Available in all BOQs in this workspace.
                  </p>
                  {addError ? (
                    <p className="unit-combobox-add-error" role="alert">
                      {addError}
                    </p>
                  ) : null}
                  <div className="unit-combobox-add-actions">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={addingUnit}
                      onClick={cancelAdd}
                    >
                      <span>Cancel</span>
                    </Button>
                    <Button type="submit" size="sm" disabled={addingUnit}>
                      <span>Add unit</span>
                    </Button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="unit-combobox-search">
                    <Search aria-hidden="true" />
                    <ComboboxPrimitive.Input
                      ref={searchRef}
                      className="unit-combobox-search-input"
                      placeholder="Search units…"
                      aria-label={`Search ${ariaLabel}`}
                    />
                  </div>
                  {workspaceLoadError ? (
                    <p className="unit-combobox-load-error" role="status">
                      {workspaceLoadError}
                    </p>
                  ) : null}
                  <ComboboxPrimitive.List className="unit-combobox-list">
                    <ComboboxPrimitive.Empty className="unit-combobox-empty">
                      No units match
                    </ComboboxPrimitive.Empty>
                    {filteredUnits.map((unit) => (
                      <ComboboxPrimitive.Item
                        key={unit}
                        value={unit}
                        className="unit-combobox-option"
                      >
                        <span>{unit}</span>
                        <ComboboxPrimitive.ItemIndicator className="unit-combobox-indicator">
                          <Check aria-hidden="true" />
                        </ComboboxPrimitive.ItemIndicator>
                      </ComboboxPrimitive.Item>
                    ))}
                  </ComboboxPrimitive.List>
                  <button
                    type="button"
                    className="unit-combobox-add-toggle"
                    onClick={() => setAdding(true)}
                  >
                    <Plus aria-hidden="true" />
                    <span>Add workspace unit</span>
                  </button>
                </>
              )}
            </ComboboxPrimitive.Popup>
          </ComboboxPrimitive.Positioner>
        </ComboboxPrimitive.Portal>
      </ComboboxPrimitive.Root>
    </div>
  )
}
