The response fixture is derived from the public Tigerair booking GraphQL
appFlightSearchResult observed on 2026-09-25. It retains only prices, route,
flight times, fare class and availability used by the parser. Session IDs,
sell keys, authentication tokens, passenger data and unrelated fields are removed.
Never use it as a live fare source.
