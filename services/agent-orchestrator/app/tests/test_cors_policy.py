# CORS origin policy: exact origins only, configurable, never a wildcard.
import pytest

from app import main


def test_default_is_the_previous_dev_origin():
    assert main.parse_cors_origins(None) == ["http://localhost:3000"]


def test_origins_are_parsed_exactly_and_trailing_slashes_dropped():
    assert main.parse_cors_origins("https://ledger.example.com/, http://localhost:3000") == [
        "https://ledger.example.com", "http://localhost:3000",
    ]


def test_empty_setting_allows_no_origin_at_all():
    assert main.parse_cors_origins("") == []


@pytest.mark.parametrize("bad", ["*", "https://*.example.com", "ledger.example.com", "ftp://x.example.com"])
def test_wildcards_and_non_origins_are_refused(bad):
    with pytest.raises(ValueError):
        main.parse_cors_origins(bad)


def test_error_response_only_echoes_an_allowed_origin():
    class Req:
        def __init__(self, origin):
            self.headers = {"origin": origin} if origin else {}

    assert main._cors_headers_for(Req("http://localhost:3000")) == {"Access-Control-Allow-Origin": "http://localhost:3000"}
    assert main._cors_headers_for(Req("https://evil.example.com")) == {}
    assert main._cors_headers_for(Req(None)) == {}
