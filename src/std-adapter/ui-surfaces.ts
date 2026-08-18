import type { SettingsSectionSpec } from 'dsh-ecosystem-spec/tui-contributions'
import type { TuiSettingsSection } from '../tui-runtime/settings-sections.js'

/** Project the portable TUI SettingsSection content into the shell registry. */
export function settingsSection(spec: SettingsSectionSpec): TuiSettingsSection {
  return {
    ns: spec.namespace,
    title: spec.title,
    ...(spec.titles === undefined ? {} : { descriptions: spec.titles }),
    fields: spec.fields.map(field => ({
      path: field.path,
      label: field.label,
      ...(field.titles === undefined ? {} : { descriptions: field.titles }),
      ...(field.hint === undefined ? {} : { hint: field.hint }),
      ...(field.hintTitles === undefined ? {} : { hintDescriptions: field.hintTitles }),
      kind: field.kind,
      ...(field.options === undefined ? {} : {
        options: field.options.map(option => ({
          value: option.value,
          label: option.label,
          ...(option.titles === undefined ? {} : { descriptions: option.titles }),
        })),
      }),
      ...(field.placeholder === undefined ? {} : { placeholder: field.placeholder }),
      ...(field.secretRef === undefined ? {} : { secret: { ref: field.secretRef } }),
    })),
  }
}
