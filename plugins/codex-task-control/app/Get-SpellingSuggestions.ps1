[CmdletBinding()]
param()

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

function Write-UnavailableResult {
    [ordered]@{
        available = $false
        language = $null
        misspelled = $null
        suggestions = @()
    } | ConvertTo-Json -Compress
}

try {
    $inputStream = [Console]::OpenStandardInput()
    $inputBuffer = New-Object byte[] 4097
    $inputLength = 0
    while ($inputLength -lt $inputBuffer.Length) {
        $bytesRead = $inputStream.Read($inputBuffer, $inputLength, $inputBuffer.Length - $inputLength)
        if ($bytesRead -eq 0) { break }
        $inputLength += $bytesRead
    }
    if ($inputLength -gt 4096) { throw 'Input is too large.' }
    $inputText = [Text.Encoding]::UTF8.GetString($inputBuffer, 0, $inputLength)
    $request = $inputText | ConvertFrom-Json
    $word = [string]$request.word
    $language = [string]$request.language
    $limit = [int]$request.limit
    if ([string]::IsNullOrWhiteSpace($word) -or $word.Length -gt 64 -or $word -notmatch "^[\p{L}\p{M}]+(?:['’\-][\p{L}\p{M}]+)*$") { throw 'Invalid word.' }
    if ($language -notmatch '^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$' -or $language.Length -gt 35) { throw 'Invalid language.' }
    if ($limit -lt 1 -or $limit -gt 8) { throw 'Invalid limit.' }

    $source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

namespace CodexTaskControlSpelling {
  enum CorrectiveAction { None = 0, GetSuggestions = 1, Replace = 2, Delete = 3 }

  [ComImport, Guid("B7C82D61-FBE8-4B47-9B27-6C0D2E0DE0A3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ISpellingError {
    uint get_StartIndex();
    uint get_Length();
    CorrectiveAction get_CorrectiveAction();
    [return: MarshalAs(UnmanagedType.LPWStr)] string get_Replacement();
  }

  [ComImport, Guid("803E3BD4-2828-4410-8290-418D1D73C762"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IEnumSpellingError {
    [return: MarshalAs(UnmanagedType.Interface)] ISpellingError Next();
  }

  [ComImport, Guid("8E018A9D-2415-4677-BF08-794EA61F94BB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ISpellCheckerFactory {
    [return: MarshalAs(UnmanagedType.Interface)] IEnumString get_SupportedLanguages();
    [return: MarshalAs(UnmanagedType.Bool)] bool IsSupported([MarshalAs(UnmanagedType.LPWStr)] string languageTag);
    [return: MarshalAs(UnmanagedType.Interface)] ISpellChecker CreateSpellChecker([MarshalAs(UnmanagedType.LPWStr)] string languageTag);
  }

  [ComImport, Guid("B6FD0B71-E2BC-4653-8D05-F197E412770B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ISpellChecker {
    [return: MarshalAs(UnmanagedType.LPWStr)] string get_LanguageTag();
    [return: MarshalAs(UnmanagedType.Interface)] IEnumSpellingError Check([MarshalAs(UnmanagedType.LPWStr)] string text);
    [return: MarshalAs(UnmanagedType.Interface)] IEnumString Suggest([MarshalAs(UnmanagedType.LPWStr)] string word);
  }

  [ComImport, Guid("7AB36653-1796-484B-BDFA-E74F1DB7C1DC")]
  class SpellCheckerFactory { }

  public sealed class Result {
    public bool available;
    public string language;
    public bool? misspelled;
    public string[] suggestions;
  }

  public static class SpellSuggestions {
    public static Result Get(string[] languages, string word, int limit) {
      var factory = (ISpellCheckerFactory)new SpellCheckerFactory();
      string selectedLanguage = null;
      foreach (var language in languages) {
        if (!String.IsNullOrWhiteSpace(language) && factory.IsSupported(language)) {
          selectedLanguage = language;
          break;
        }
      }
      if (selectedLanguage == null) return new Result { available = false, suggestions = new string[0] };

      var checker = factory.CreateSpellChecker(selectedLanguage);
      var error = checker.Check(word).Next();
      if (error == null) {
        return new Result { available = true, language = selectedLanguage, misspelled = false, suggestions = new string[0] };
      }

      var values = new List<string>();
      var replacement = error.get_Replacement();
      if (!String.IsNullOrWhiteSpace(replacement)) values.Add(replacement);
      var enumerator = checker.Suggest(word);
      var buffer = new string[1];
      while (values.Count < limit && enumerator.Next(1, buffer, IntPtr.Zero) == 0) {
        if (!String.IsNullOrWhiteSpace(buffer[0]) && !values.Contains(buffer[0])) values.Add(buffer[0]);
      }
      return new Result { available = true, language = selectedLanguage, misspelled = true, suggestions = values.ToArray() };
    }
  }
}
'@
    Add-Type -TypeDefinition $source -Language CSharp
    $culture = Get-Culture
    $languages = @($language, $culture.Name, $culture.TwoLetterISOLanguageName, 'en-AU', 'en-GB', 'en-US') |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        Select-Object -Unique
    [CodexTaskControlSpelling.SpellSuggestions]::Get($languages, $word, $limit) | ConvertTo-Json -Compress
}
catch {
    Write-UnavailableResult
}
