# Centro Quant Markets v1.1.1

Copia separada de Centro Quant Crypto para experimentar el mismo motor cuantitativo sobre otros mercados.

## Universo inicial
- Índices mediante ETFs: SPY, QQQ, DIA, IWM
- Metales/commodities mediante ETFs: GLD, SLV, COPX, USO, UNG, DBA
- Acciones líquidas de gran capitalización de varios sectores

## Datos
Usa Twelve Data. Configura tu API key desde **Sistema**. La clave queda en localStorage y no se incluye en los respaldos.

## Aislamiento
Las claves locales usan el prefijo `markets_quant_`, por lo que operaciones, favoritos, pesos y respaldos no se mezclan con Centro Quant Crypto.

## Objetivo
Comparar el comportamiento del Score, temporalidades, Long/Short, MFE y resultados de paper trading entre familias de mercados antes de optimizar reglas.
