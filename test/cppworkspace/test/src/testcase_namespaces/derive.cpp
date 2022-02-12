#include "derive.hpp"

namespace derive
{
    void take_interface(Base *b)
    {
        b->sayHello();
        std::cout << "good bye" << std::endl;
    }

    void two_impls()
    {
        Base *ba = new Derived{"foo"};
        IntDerived *bb = new IntDerived{42};
        bb->foo();
        take_interface(ba);
        take_interface(bb);
    }

    void testFinalDerived()
    {
        auto f = new Final{10, 1};
        f->sayHello();
        std::cout << "say hello, through interface" << std::endl;
        take_interface(f);
    }

    void main()
    {
        two_impls();
        testFinalDerived();
    }
} // namespace derive
