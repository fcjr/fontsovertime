# Fonts Over Time dataset license

Copyright © 2026 Frank Chiarulli Jr.

Frank Chiarulli Jr. is the licensor of the copyright and similar rights he holds
in the dataset described below, offered under the **Creative Commons Attribution
4.0 International license (CC BY 4.0)**.

Other contributors retain any rights they hold in their own contributions.
Their existing copyright, license and attribution notices remain in effect.
This notice does not claim ownership of their work or grant rights the licensor
does not hold.

- [License summary](https://creativecommons.org/licenses/by/4.0/)
- [Full legal text](LICENSES/CC-BY-4.0.txt), reproduced without modification from
  [Creative Commons](https://creativecommons.org/licenses/by/4.0/legalcode.txt)

## What is covered

This grant covers the project's collected font-usage observations and its
selection, arrangement and aggregation of those observations, including any
database rights the licensor holds, in:

- `data/snapshots/`: the weekly, daily, archive (`wayback`) and Hacker News (`hn`)
  crawl snapshots
- `data/exports/`: the CSV exports, including `latest.csv`
- `data/agg/`: the generated font-usage aggregates, including copies served by
  [fontsovertime.com](https://fontsovertime.com)

Subject to the exclusions below, the grant covers existing published snapshots
as well as new data published under this notice. You may copy, keep dated copies,
redistribute, analyze and adapt this data, including for commercial use, under
the license terms.

## What is not covered

This grant applies only to rights Frank Chiarulli Jr. can license.
It does not license:

- Font software or typeface designs, whether named, linked to or measured by the
  dataset. A font's presence in this dataset says nothing about permission to use
  the font itself; consult the font's own license and rights holder.
- Third-party website or archive content, including copied page titles,
  descriptions, text, images, HTML or CSS. Some snapshot fields contain such
  material; its inclusion does not place it under CC BY 4.0.
- Upstream site lists, font catalogs or reference data, including `sites/`,
  `pipeline/catalog.json` and `pipeline/public_suffix_list.dat`, or third-party
  material carried from those sources into the outputs. Their existing licenses
  and notices are unchanged. See the [source list in the README](README.md#site-lists).
- The crawler, pipeline, website source code or other software in this
  repository. This notice does not add or change a software license.

Individual facts may not be protected by copyright. This notice claims no new
rights in those facts. The license's conditions, including attribution, apply
only when your use requires permission under rights the licensor holds.
Public-domain material and uses permitted by an applicable exception or
limitation do not require compliance with this license.

## Attribution

When sharing covered material in a way that requires this license, credit
**Frank Chiarulli Jr. (Fonts Over Time)**, link to the project and CC BY 4.0,
indicate your changes, and retain the copyright notice above and any other
supplied notices and indications of earlier changes as required by the license.
Attribution may be provided in any reasonable manner for the medium, such as a
methodology page or accompanying README. Do not imply endorsement by the project
or its contributors.

For example, for a ranking derived from a snapshot:

> Data from [Fonts Over Time](https://fontsovertime.com) by Frank Chiarulli Jr.
> Copyright © 2026 Frank Chiarulli Jr. Licensed under
> [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
> Changes: calculated font rankings from the 2026-W39 weekly snapshot.
> The source data is provided without warranties; see the
> [dataset license notice](https://github.com/fcjr/fontsovertime/blob/main/LICENSE-DATA.md).

Replace the snapshot and change description with the ones you actually used.
Keeping a snapshot filename or commit reference is also useful for
reproducibility, but is not an additional license condition.

The dataset is provided as-is and as-available, without warranties, including
as to accuracy or third-party rights, as set out in Section 5 of CC BY 4.0.
The full legal text governs; this notice identifies the material and rights
being offered and does not add conditions to the license.
