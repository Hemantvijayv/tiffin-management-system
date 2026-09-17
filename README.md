# Tiffin Management System

## Problem statement

Build a tiffin subscription and billing system for a kitchen business that manages customers, daily meal service, pauses, and monthly billing. The application should help operators track active and paused subscriptions, record daily deliveries, and calculate the correct amount due for each billing cycle based on weekdays, customer subscription dates, and pause periods.

The system must support:

- Creating and updating customer subscriptions with a name, phone number, and monthly price.
- Tracking customer status as active or paused.
- Recording delivery logs for each date the tiffin was served.
- Calculating billing for a selected month using only valid weekdays, starting from the subscription date, excluding paused days, and crediting only delivered service days.
- Providing a dashboard summary of customer counts, served days, and month-level revenue.

## Twist requirements

### Level 1 — T1 (integrate)

Each morning, notify the customers due a delivery today (active, a weekday, not paused) via the Notification Service. The system must expose the notification batch through the outbox after a POST to /clock so operators can verify what was queued for dispatch.

### Level 2 — T6 (lifecycle)

Transfer a subscription to a new customer mid-cycle. The plan and cycle should carry over, while billing should split correctly based on who was served for the period. The app must handle ownership transfer without duplicating the original customer record or breaking the active billing schedule.

### Level 3 — T4 (messy data)

Import a messy customer list containing duplicate phone numbers, mixed date formats, blank fields, and inconsistent data quality. The import flow must produce a clean set of subscriptions and a structured report with counts for imported, deduped, and rejected records.

## Expected behavior

- A user can subscribe a customer and immediately see that customer in the roster and dashboard.
- A user can pause or resume a customer without losing historical billing data.
- A user can mark a delivery for a chosen date and see the monthly amount update accordingly.
- A user can select a billing month to review totals and billable days for all customers.
- A user can import messy records and receive a clear validation summary rather than silently accepting bad data.

## Implementation notes

This project is designed as a small Express + SQLite application with a browser-based dashboard. It should be easy to run locally and should keep the business logic in a testable form so edge cases like pause windows, mid-cycle transfers, and messy imports can be covered systematically.
