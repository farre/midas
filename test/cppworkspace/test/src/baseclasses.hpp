#pragma once

namespace baseclasses { 
    struct Foo {
            Foo(int i) : foo_value(i) { }
            int foo_value;
    };

    struct Bar : public Foo {
            Bar(int I): Foo(I*2), bar_value(I) { }
            int bar_value;
    };

    struct Quux : public Bar {
            Quux(int I): Bar(I*2), quux_value(I) { }
            int quux_value;
    };

    struct Baz {
            Baz(int k) : baz_value(k) { }
            int baz_value;
    };

    struct Zoo : public Baz, public Quux {
            Zoo(int i) : Baz(i + 2), Quux(i * 2), zoo_value(i) { }
            int zoo_value;
    };

    struct Tricky : public Bar {
        Tricky(int tricky) : Bar(tricky * 2), tricky(tricky), q{tricky * 42} {}
        Quux q;
        int tricky;
    };

    void main();
}

