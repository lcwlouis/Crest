#!/bin/zsh
# Regenerates the contract codecs and models from the C# contract records, the
# core's CrestCore.Contracts namespace: the core's ContractCodec, the two Swift
# files under CrestShared/Infrastructure/Core/Generated,
# CrestContracts/include/crest_contracts.h, the C++ engine codec
# CrestContracts/include/crest_engine_contract.h and the TypeScript contracts
# CrestLinux/WebUI/generated/crest_contracts.ts. Pass --check to verify that
# they are current without writing anything.
set -euo pipefail

repository_root="${0:A:h:h:h}"
dotnet run --project "$repository_root/CrestCore/tools/CrestCore.Generator" --nologo -- --root "$repository_root" "$@"
