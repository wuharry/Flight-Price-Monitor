-- Optional example. Edit these dates/thresholds before enabling your watch.
insert into public.watch_rules(id, provider, origin, destination, departure_date, return_date,
  adults, currency, target_price, notify_new_low, new_low_days, drop_amount, drop_percent, enabled)
values ('16c47be1-218f-4ae6-9d52-09175e1b8d02', 'tigerair', 'TPE', 'NRT', '2027-02-10', '2027-02-16',
  1, 'TWD', 6500, true, 30, 1000, 15, true)
on conflict (id) do nothing;
